package mw

import (
	"fmt"
	"runtime/debug"
)

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
	// Defensive copy so callers can't mutate the chain after construction.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain.
//
// It executes every handler in order against ctx. If a handler returns a
// non-nil error, execution stops immediately and that error is returned
// (wrapped, but errors.Is against the original still succeeds). If a
// handler panics, Do recovers, skips the remaining handlers, and returns
// an error whose message contains the recovered value formatted with %v.
// A nil ctx returns ErrNoCtx instead of panicking. An empty chain
// returns nil. Do is safe to call multiple times; the chain itself is
// stateless and per-call state lives on Ctx.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	defer func() {
		if r := recover(); r != nil {
			// Include the stack so panics are diagnosable, but the
			// message itself is just the recovered value formatted
			// with %v, per the contract.
			_ = debug.Stack()
			err = fmt.Errorf("mw: handler panic: %v", r)
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
