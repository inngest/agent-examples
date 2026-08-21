package mw

import "fmt"

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
//
// Handlers are executed in the order they were passed (first added runs
// first). The returned Chain is stateless and may be reused across many
// Do calls; per-call state lives on the Ctx.
func New(handlers ...Handler) *Chain {
	// Copy the slice so later mutations by the caller can't affect us.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain.
//
// It executes every handler in order against ctx. If a handler returns
// a non-nil error, execution stops and that error is returned (wrapped
// with %w so errors.Is works against the original). If a handler
// panics, Do recovers, skips the remaining handlers, and returns an
// error whose message contains the recovered value formatted with %v.
// Do never panics. A nil ctx returns ErrNoCtx. An empty chain returns
// nil.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	// Panic recovery: turn any panic into an error and stop the chain.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if err = h(ctx); err != nil {
			return fmt.Errorf("mw: handler error: %w", err)
		}
	}
	return nil
}
