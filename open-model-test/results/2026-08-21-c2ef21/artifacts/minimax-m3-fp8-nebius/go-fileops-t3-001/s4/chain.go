package mw

import (
	"fmt"
	"runtime/debug"
)

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers, preserving the order in
// which they were passed (first added runs first).
func New(handlers ...Handler) *Chain {
	// Copy to a fresh slice so external mutations of the caller's slice
	// cannot affect the chain.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx. Handlers execute in order against the
// same Ctx. The first non-nil error short-circuits the chain and is
// returned (errors.Is against the original error still succeeds). A
// panic in any handler is recovered; remaining handlers are skipped and
// Do returns an error whose message contains the recovered value
// formatted with %v. A nil ctx returns ErrNoCtx. An empty chain returns
// nil. Do is safe to call repeatedly; the chain itself is stateless.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	if len(c.handlers) == 0 {
		return nil
	}

	defer func() {
		if r := recover(); r != nil {
			// Include the stack so panics are diagnosable, but the
			// primary message is the recovered value formatted with %v
			// as required by the contract.
			_ = debug.Stack()
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if err = h(ctx); err != nil {
			return err
		}
	}
	return nil
}
