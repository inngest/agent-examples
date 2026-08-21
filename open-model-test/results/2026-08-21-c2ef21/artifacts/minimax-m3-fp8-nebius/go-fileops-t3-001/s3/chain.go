package mw

import (
	"fmt"
)

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
//
// Handlers run in the order they were passed: the first handler runs first.
// If a handler returns a non-nil error, the chain stops and Do returns that
// error. If a handler panics, Do recovers, skips the remaining handlers,
// and returns an error whose message contains the recovered value formatted
// with %v.
func New(handlers ...Handler) *Chain {
	// Defensive copy so later mutations by the caller cannot affect us.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx. It is safe to call Do repeatedly; each
// invocation starts fresh from the first handler. A nil ctx returns
// ErrNoCtx instead of panicking. An empty chain returns nil.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}
	if len(c.handlers) == 0 {
		return nil
	}

	// Panic recovery: any panic in any handler aborts the chain and is
	// converted into an error. We assign to the named return value so the
	// recovered error is propagated to the caller.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if e := h(ctx); e != nil {
			// Return the original error directly so errors.Is(err, e)
			// succeeds. Wrapping is permitted by the contract but not
			// required; returning the original is the simplest way to
			// satisfy the errors.Is requirement.
			return e
		}
	}
	return nil
}
