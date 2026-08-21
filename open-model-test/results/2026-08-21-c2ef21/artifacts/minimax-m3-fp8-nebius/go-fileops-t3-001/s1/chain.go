package mw

// Chain executes an ordered list of handlers in the order they were added.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers, preserving the order in which
// they were passed (first added runs first).
func New(handlers ...Handler) *Chain {
	// Copy to avoid surprises if the caller mutates the underlying slice.
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain against ctx. It returns ErrNoCtx if ctx is nil. If a
// handler returns a non-nil error, execution stops and that error is
// returned (wrapped, but still matching via errors.Is). If a handler
// panics, Do recovers, skips the remaining handlers, and returns an error
// whose message contains the recovered value formatted with %v. Do itself
// never panics. The chain is stateless; each call starts fresh.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	defer func() {
		if r := recover(); r != nil {
			err = fmtErrorf("mw: handler panic: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if err = h(ctx); err != nil {
			return wrapHandlerErr(err)
		}
	}
	return nil
}
