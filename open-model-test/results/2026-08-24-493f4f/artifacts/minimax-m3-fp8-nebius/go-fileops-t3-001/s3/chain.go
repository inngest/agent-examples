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

// Do runs the chain against ctx. It returns the first non-nil error
// produced by a handler, or an error wrapping a recovered panic value.
// A nil ctx yields ErrNoCtx. An empty chain returns nil.
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

// safeCall invokes h(ctx) and converts any panic into an error whose
// message contains the recovered value formatted with %v.
func safeCall(h Handler, ctx *Ctx) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: handler panic: %v", r)
		}
	}()
	return h(ctx)
}
