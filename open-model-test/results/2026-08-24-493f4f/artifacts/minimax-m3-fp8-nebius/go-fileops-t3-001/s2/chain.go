package mw

import (
	"fmt"
	"runtime/debug"
)

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers in the order they were passed.
func New(handlers ...Handler) *Chain {
	// Copy to avoid retaining the caller's slice across mutations.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx, stopping on the first error or panic.
func (c *Chain) Do(ctx *Ctx) error {
	if ctx == nil {
		return ErrNoCtx
	}

	var err error
	for _, h := range c.handlers {
		err = safeCall(h, ctx)
		if err != nil {
			return err
		}
	}
	return nil
}

// safeCall invokes h with ctx, recovering from any panic and converting it
// into an error whose message contains the recovered value formatted with %v.
func safeCall(h Handler, ctx *Ctx) (err error) {
	defer func() {
		if r := recover(); r != nil {
			_ = debug.Stack() // keep stack available for future logging hooks
			err = fmt.Errorf("mw: handler panicked: %v", r)
		}
	}()
	return h(ctx)
}
