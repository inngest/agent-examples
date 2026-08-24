package mw

import "fmt"

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
//
// Handlers are executed in the order they were passed: the first handler
// runs first, and each subsequent handler runs only if the previous one
// returned a nil error.
func New(handlers ...Handler) *Chain {
	// Copy the slice so later mutations by the caller cannot affect us.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain.
//
// It executes every handler in order against the same Ctx. If a handler
// returns a non-nil error, execution stops immediately and that error is
// returned (wrapped, but errors.Is against the original still succeeds).
// If a handler panics, Do recovers, skips the remaining handlers, and
// returns an error whose message contains the recovered value formatted
// with %v. Do itself never panics. A nil Ctx yields ErrNoCtx. An empty
// chain returns nil.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	// Panic recovery: any panic from a handler stops the chain and is
	// converted into an error. We use a named return so the deferred
	// function can set the result.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if e := h(ctx); e != nil {
			// Wrap the error so callers can still use errors.Is to
			// inspect the original cause.
			return fmt.Errorf("mw: handler error: %w", e)
		}
	}
	return nil
}
