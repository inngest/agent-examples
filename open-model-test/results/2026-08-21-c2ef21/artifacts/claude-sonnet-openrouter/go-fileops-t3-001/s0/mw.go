// Package mw is a tiny, HTTP-agnostic middleware chain.
package mw

import "errors"

// Ctx carries per-call state between handlers.
type Ctx struct {
	values map[string]any
}

// Set stores a value under key.
func (c *Ctx) Set(key string, v any) {
	if c.values == nil {
		c.values = map[string]any{}
	}
	c.values[key] = v
}

// Get fetches a value under key (zero value if absent).
func (c *Ctx) Get(key string) any {
	return c.values[key]
}

// Handler is one step in a chain.
type Handler func(*Ctx) error

// ErrNoCtx is returned when Do is called with a nil Ctx.
var ErrNoCtx = errors.New("mw: nil context")
