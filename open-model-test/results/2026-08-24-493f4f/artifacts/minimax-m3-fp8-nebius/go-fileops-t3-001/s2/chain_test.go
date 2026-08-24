package mw

import (
	"errors"
	"fmt"
	"testing"
)

func TestChain_Order(t *testing.T) {
	var order []int
	c := New(
		func(ctx *Ctx) error { order = append(order, 1); return nil },
		func(ctx *Ctx) error { order = append(order, 2); return nil },
		func(ctx *Ctx) error { order = append(order, 3); return nil },
	)
	if err := c.Do(&Ctx{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(order) != 3 || order[0] != 1 || order[1] != 2 || order[2] != 3 {
		t.Fatalf("wrong order: %v", order)
	}
}

func TestChain_ShortCircuitOnError(t *testing.T) {
	sentinel := errors.New("boom")
	var ran []int
	c := New(
		func(ctx *Ctx) error { ran = append(ran, 1); return nil },
		func(ctx *Ctx) error { ran = append(ran, 2); return sentinel },
		func(ctx *Ctx) error { ran = append(ran, 3); return nil },
	)
	err := c.Do(&Ctx{})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}
	if len(ran) != 2 {
		t.Fatalf("expected 2 handlers to run, got %v", ran)
	}
}

func TestChain_PanicRecovery(t *testing.T) {
	c := New(
		func(ctx *Ctx) error { return nil },
		func(ctx *Ctx) error { panic("kaboom") },
		func(ctx *Ctx) error { t.Fatal("should not run after panic"); return nil },
	)
	err := c.Do(&Ctx{})
	if err == nil {
		t.Fatal("expected error from panic")
	}
	if msg := fmt.Sprintf("%v", err); msg == "" {
		t.Fatal("error message empty")
	}
	if !contains(err.Error(), "kaboom") {
		t.Fatalf("error message %q does not contain recovered value", err.Error())
	}
}

func TestChain_NilCtx(t *testing.T) {
	c := New(func(ctx *Ctx) error { return nil })
	if err := c.Do(nil); !errors.Is(err, ErrNoCtx) {
		t.Fatalf("expected ErrNoCtx, got %v", err)
	}
}

func TestChain_Empty(t *testing.T) {
	c := New()
	if err := c.Do(&Ctx{}); err != nil {
		t.Fatalf("empty chain should return nil, got %v", err)
	}
}

func TestChain_Reusable(t *testing.T) {
	var n int
	c := New(func(ctx *Ctx) error { n++; return nil })
	for i := 0; i < 3; i++ {
		if err := c.Do(&Ctx{}); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if n != 3 {
		t.Fatalf("expected handler to run 3 times, got %d", n)
	}
}

func TestChain_CtxState(t *testing.T) {
	c := New(
		func(ctx *Ctx) error { ctx.Set("a", 1); return nil },
		func(ctx *Ctx) error {
			if ctx.Get("a") != 1 {
				t.Fatalf("expected a=1, got %v", ctx.Get("a"))
			}
			return nil
		},
	)
	if err := c.Do(&Ctx{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
