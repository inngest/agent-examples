package mw

// Chain executes an ordered list of handlers.
type Chain struct{}

// New builds a Chain over the given handlers.
//
// TODO: implement the real chain (ordering, short-circuit on error, panic
// recovery) per the task contract.
func New(handlers ...Handler) *Chain {
	return &Chain{}
}

// Do runs the chain.
func (c *Chain) Do(ctx *Ctx) error {
	return nil
}
