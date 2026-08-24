package mw

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestOrder(t *testing.T) {
	var order []string
	ch := New(
		func(*Ctx) error { order = append(order, "a"); return nil },
		func(*Ctx) error { order = append(order, "b"); return nil },
		func(*Ctx) error { order = append(order, "c"); return nil },
	)
	if err := ch.Do(&Ctx{}); err != nil {
		t.Fatalf("Do returned %v", err)
	}
	if strings.Join(order, "") != "abc" {
		t.Errorf("handlers ran in order %v, want a,b,c", order)
	}
}

func TestSharedCtx(t *testing.T) {
	ch := New(
		func(c *Ctx) error { c.Set("n", 41); return nil },
		func(c *Ctx) error { c.Set("n", c.Get("n").(int)+1); return nil },
		func(c *Ctx) error { c.Set("n", c.Get("n").(int)*1); return nil },
	)
	ctx := &Ctx{}
	if err := ch.Do(ctx); err != nil {
		t.Fatalf("Do returned %v", err)
	}
	if got := ctx.Get("n").(int); got != 42 {
		t.Errorf("shared ctx: got %d, want 42", got)
	}
}

func TestShortCircuitOnError(t *testing.T) {
	sentinel := errors.New("stop")
	ran := 0
	ch := New(
		func(*Ctx) error { ran++; return nil },
		func(*Ctx) error { ran++; return sentinel },
		func(*Ctx) error { ran++; return nil },
	)
	err := ch.Do(&Ctx{})
	if !errors.Is(err, sentinel) {
		t.Fatalf("Do error = %v, want the sentinel via errors.Is", err)
	}
	if ran != 2 {
		t.Errorf("handlers run after error: total ran = %d, want 2", ran)
	}
}

func TestPanicRecovery(t *testing.T) {
	ran := 0
	ch := New(
		func(*Ctx) error { ran++; return nil },
		func(*Ctx) error { ran++; panic("kaboom") },
		func(*Ctx) error { ran++; return nil },
	)
	err := ch.Do(&Ctx{})
	if err == nil {
		t.Fatalf("Do recovered panic must return an error, got nil")
	}
	if !strings.Contains(fmt.Sprintf("%v", err), "kaboom") {
		t.Errorf("error %q does not mention the panic value", err)
	}
	if ran != 2 {
		t.Errorf("handlers run after panic: total ran = %d, want 2", ran)
	}
}

func TestPanicNonStringValue(t *testing.T) {
	ch := New(func(*Ctx) error { panic(42) })
	err := ch.Do(&Ctx{})
	if err == nil || !strings.Contains(fmt.Sprintf("%v", err), "42") {
		t.Errorf("non-string panic value must appear in error, got %v", err)
	}
}

func TestNilCtx(t *testing.T) {
	ch := New(func(*Ctx) error { return nil })
	if err := ch.Do(nil); err == nil {
		t.Fatalf("Do(nil) must return an error, got nil")
	}
}

func TestEmptyChain(t *testing.T) {
	ch := New()
	if err := ch.Do(&Ctx{}); err != nil {
		t.Errorf("empty chain Do = %v, want nil", err)
	}
}

func TestReuse(t *testing.T) {
	var calls int
	ch := New(func(*Ctx) error { calls++; return nil })
	ctx1, ctx2 := &Ctx{}, &Ctx{}
	if err := ch.Do(ctx1); err != nil {
		t.Fatalf("first Do: %v", err)
	}
	if err := ch.Do(ctx2); err != nil {
		t.Fatalf("second Do: %v", err)
	}
	if calls != 2 {
		t.Errorf("chain reuse: handler called %d times, want 2", calls)
	}
}
