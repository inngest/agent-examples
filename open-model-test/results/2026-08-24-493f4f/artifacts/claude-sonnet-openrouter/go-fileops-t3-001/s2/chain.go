package mw

import (
	"fmt"
)

// Chain executes an ordered list of handlers.
type Chain struct {
	handlers []Handler
}

// New builds a Chain over the given handlers.
func New(handlers ...Handler) *Chain {
	hs := make([]Handler, len(handlers))
	copy(hs, handlers)
	return &Chain{handlers: hs}
}

// Do runs the chain.
func (c *Chain) Do(ctx *Ctx) (err error) {
	if ctx == nil {
		return ErrNoCtx
	}

	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("mw: panic recovered: %v", r)
		}
	}()

	for _, h := range c.handlers {
		if err := h(ctx); err != nil {
			return fmt.Errorf("mw: handler error: %w", err)
		}
	}

	return nil
}
