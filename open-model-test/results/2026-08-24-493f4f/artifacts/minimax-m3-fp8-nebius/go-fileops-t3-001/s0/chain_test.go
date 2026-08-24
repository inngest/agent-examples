package mw

import (
	"errors"
	"fmt"
	"testing"
)

func TestNew_OrderPreserved(t *testing.T) {
	var order []int
	mk := func(i int) Handler {
		return func(*Ctx) error {
			order = append(order, i)
			return nil
		}
	}
	c := New(mk(1), mk(2), mk(3))
	if err := c.Do(&Ctx{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []int{1, 2, 3}
	if len(order) != len(want) {
		t.Fatalf("got %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("got %v, want %v", order, want)
		}
	}
}

func TestDo_StopsOnError(t *testing.T) {
	sentinel := errors.New("boom")
	var ran []int
	mk := func(i int, err error) Handler {
		return func(*Ctx) error {
			ran = append(ran, i)
			return err
		}
	}
	c := New(mk(1, nil), mk(2, sentinel), mk(3, nil))
	err := c.Do(&Ctx{})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel, got %v", err)
	}
	if len(ran) != 2 || ran[0] != 1 || ran[1] != 2 {
		t.Fatalf("expected [1 2], got %v", ran)
	}
}

func TestDo_PanicRecovered(t *testing.T) {
	c := New(
		func(*Ctx) error { return nil },
		func(*Ctx) error { panic("kaboom") },
		func(*Ctx) error { return nil },
	)
	err := c.Do(&Ctx{})
	if err == nil {
		t.Fatal("expected error from panic")
	}
	if msg := fmt.Sprintf("%v", err); msg == "" || !contains(msg, "kaboom") {
		t.Fatalf("error %q should contain recovered value", msg)
	}
}

func TestDo_NilCtx(t *testing.T) {
	c := New(func(*Ctx) error { return nil })
	if err := c.Do(nil); !errors.Is(err, ErrNoCtx) {
		t.Fatalf("expected ErrNoCtx, got %v", err)
	}
}

func TestDo_EmptyChain(t *testing.T) {
	c := New()
	if err := c.Do(&Ctx{}); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestDo_MultipleCalls(t *testing.T) {
	var n int
	c := New(func(*Ctx) error {
		n++
		return nil
	})
	for i := 0; i < 3; i++ {
		if err := c.Do(&Ctx{}); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if n != 3 {
		t.Fatalf("expected 3 invocations, got %d", n)
	}
}

func TestCtx_SetGet(t *testing.T) {
	ctx := &Ctx{}
	ctx.Set("k", "v")
	if got := ctx.Get("k"); got != "v" {
		t.Fatalf("got %v, want v", got)
	}
	if got := ctx.Get("missing"); got != nil {
		t.Fatalf("expected nil for missing key, got %v", got)
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
