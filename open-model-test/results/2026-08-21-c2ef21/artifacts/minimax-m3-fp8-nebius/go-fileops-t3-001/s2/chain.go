package mw

import "fmt"

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
//
// Handlers run in the order they were passed: the first handler runs first.
// The returned Chain is stateless and may be reused across multiple Do calls.
func New(handlers ...Handler) *Chain {
	// Copy the slice so external mutations to the caller's slice don't
	// affect the chain.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx.
//
// Behavior:
//   - A nil ctx returns ErrNoCtx instead of panicking.
//   - Handlers run in order against the same Ctx.
//   - If a handler returns a non-nil error, execution stops and that error
//     is returned (wrapped, but errors.Is still matches the original).
//   - If a handler panics, Do recovers, skips remaining handlers, and
//     returns an error whose message contains the recovered value formatted
//     with %v. Do itself never panics.
//   - An empty chain returns nil.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	// Defer a panic recovery so Do never propagates a panic to its caller.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panicked: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if err := h(ctx); err != nil {
			// Wrap so callers can still use errors.Is(err, original).
			return fmt.Errorf("mw: handler error: %w", err)
		}
	}
	return nil
}
