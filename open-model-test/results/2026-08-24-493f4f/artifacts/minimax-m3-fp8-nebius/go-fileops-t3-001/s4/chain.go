package mw

import "fmt"

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
//
// Handlers run in the order they were passed: the first argument runs
// first. The returned chain is stateless and may be reused across many
// Do calls; per-call state lives on the Ctx.
func New(handlers ...Handler) *Chain {
	// Copy to detach from the caller's slice so later mutations by the
	// caller cannot affect the chain.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain.
//
// It executes every handler in registration order against ctx. If a
// handler returns a non-nil error, execution stops and that error is
// returned (wrapped, but errors.Is still matches the original). If a
// handler panics, Do recovers, skips the remaining handlers, and
// returns an error whose message contains the recovered value
// formatted with %v. A nil ctx yields ErrNoCtx instead of panicking.
// An empty chain returns nil.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	// Panic recovery: any panic in any handler aborts the chain and is
	// converted into an error. We use a named return so the deferred
	// function can capture the panic value and assign to err.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if h == nil {
			// Treat a nil handler as a no-op so a misconfigured chain
			// does not crash the program.
			continue
		}
		if e := h(ctx); e != nil {
			err = fmt.Errorf("mw: handler error: %w", e)
			return err
		}
	}

	return nil
}
