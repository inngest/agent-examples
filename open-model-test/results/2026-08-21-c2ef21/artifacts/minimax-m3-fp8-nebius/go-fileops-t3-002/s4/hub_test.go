package bus

import (
	"errors"
	"testing"
)

func TestSubscribeAndPublish(t *testing.T) {
	b := New()
	var got []string
	b.Subscribe("user.created", func(topic string, payload any) error {
		got = append(got, "u:"+topic)
		return nil
	})
	b.Subscribe("user.*", func(topic string, payload any) error {
		got = append(got, "w:"+topic)
		return nil
	})
	b.Subscribe("*", func(topic string, payload any) error {
		got = append(got, "a:"+topic)
		return nil
	})

	if errs := b.Publish("user.created", nil); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	want := []string{"u:user.created", "w:user.created", "a:user.created"}
	if !equalStrings(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestWildcardDoesNotMatchMultipleSegments(t *testing.T) {
	b := New()
	called := 0
	b.Subscribe("user.*", func(topic string, payload any) error {
		called++
		return nil
	})
	b.Publish("user.profile.updated", nil)
	if called != 0 {
		t.Fatalf("wildcard matched across segments: %d", called)
	}
}

func TestUnsubscribe(t *testing.T) {
	b := New()
	called := 0
	unsub := b.Subscribe("x", func(topic string, payload any) error {
		called++
		return nil
	})
	unsub()
	if errs := b.Publish("x", nil); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if called != 0 {
		t.Fatalf("called after unsubscribe: %d", called)
	}
	// Double unsubscribe must be safe.
	unsub()
}

func TestErrorIsolation(t *testing.T) {
	b := New()
	boom := errors.New("boom")
	var order []int
	b.Subscribe("e", func(topic string, payload any) error {
		order = append(order, 1)
		return boom
	})
	b.Subscribe("e", func(topic string, payload any) error {
		order = append(order, 2)
		return nil
	})
	b.Subscribe("e", func(topic string, payload any) error {
		order = append(order, 3)
		return errors.New("late")
	})
	errs := b.Publish("e", nil)
	if len(errs) != 2 {
		t.Fatalf("expected 2 errors, got %d: %v", len(errs), errs)
	}
	if !errors.Is(errs[0], boom) {
		t.Fatalf("first error not boom: %v", errs[0])
	}
	if errs[1].Error() != "late" {
		t.Fatalf("second error wrong: %v", errs[1])
	}
	if len(order) != 3 {
		t.Fatalf("subscriber order broken: %v", order)
	}
}

func TestNilSubscriber(t *testing.T) {
	b := New()
	unsub := b.Subscribe("n", nil)
	if errs := b.Publish("n", nil); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	unsub() // must not panic
}

func TestNoMatchesReturnsNil(t *testing.T) {
	b := New()
	if errs := b.Publish("nothing", nil); errs != nil {
		t.Fatalf("expected nil, got %v", errs)
	}
}

func TestPanicIsContained(t *testing.T) {
	b := New()
	b.Subscribe("p", func(topic string, payload any) error {
		panic("nope")
	})
	b.Subscribe("p", func(topic string, payload any) error {
		return nil
	})
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Publish propagated panic: %v", r)
		}
	}()
	errs := b.Publish("p", nil)
	if len(errs) != 1 {
		t.Fatalf("expected 1 error from panic, got %d", len(errs))
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
