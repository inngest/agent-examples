package mw

import (
	"fmt"
	"runtime/debug"
)

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers. Handlers run in the order
// they were passed (first added runs first).
func New(handlers ...Handler) *Chain {
	// Copy to keep the chain stateless and immune to later mutation by
	// the caller.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx. It returns:
//   - nil if ctx is nil (via ErrNoCtx),
//   - nil if the chain is empty,
//   - the first non-nil error returned by a handler (subsequent handlers
//     are skipped), or
//   - an error wrapping a recovered panic value, formatted with %v.
//
// Do is safe to call multiple times; the chain itself holds no per-call
// state.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
			_ = debug.Stack() // keep stack available to runtime; not retained
		}
	}()

	for _, h := range c.handlers {
		if err = h(ctx); err != nil {
			return err
		}
	}
	return nil
}
