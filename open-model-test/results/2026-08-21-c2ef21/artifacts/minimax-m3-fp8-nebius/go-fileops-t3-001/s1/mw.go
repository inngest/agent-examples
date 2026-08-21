// Package mw is a tiny, HTTP-agnostic middleware chain.
package mw

import (
	"errors"
	"fmt"
)

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

// fmtErrorf is a tiny indirection so chain.go can build error messages
// without importing fmt at the top level (keeps the file focused on the
// chain logic).
func fmtErrorf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}

// wrapHandlerErr wraps a handler error so callers can still match it with
// errors.Is, while preserving the original error in the chain.
func wrapHandlerErr(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("mw: handler error: %w", err)
}
