package bus

import (
	"errors"
	"strings"
	"testing"
)

func TestExactTopics(t *testing.T) {
	b := New()
	var got []string
	b.Subscribe("user.created", func(topic string, _ any) error {
		got = append(got, topic)
		return nil
	})
	b.Publish("user.updated", 1)
	if len(got) != 0 {
		t.Errorf("non-matching topic delivered: %v", got)
	}
	b.Publish("user.created", 1)
	if len(got) != 1 {
		t.Errorf("matching topic not delivered exactly once: %v", got)
	}
}

func TestSubscriptionOrder(t *testing.T) {
	b := New()
	var order []string
	b.Subscribe("t", func(string, any) error { order = append(order, "first"); return nil })
	b.Subscribe("t", func(string, any) error { order = append(order, "second"); return nil })
	b.Subscribe("t", func(string, any) error { order = append(order, "third"); return nil })
	b.Publish("t", nil)
	if strings.Join(order, ",") != "first,second,third" {
		t.Errorf("dispatch order = %v, want subscription order", order)
	}
}

func TestWildcardOneSegment(t *testing.T) {
	b := New()
	var matched []string
	b.Subscribe("user.*", func(topic string, _ any) error {
		matched = append(matched, topic)
		return nil
	})
	b.Publish("user.created", nil)
	b.Publish("user.updated", nil)
	b.Publish("user.profile.updated", nil)
	b.Publish("mail.sent", nil)
	if strings.Join(matched, ",") != "user.created,user.updated" {
		t.Errorf("user.* matched %v, want exactly the two one-segment topics", matched)
	}
}

func TestLoneWildcard(t *testing.T) {
	b := New()
	var n int
	b.Subscribe("*", func(string, any) error { n++; return nil })
	b.Publish("a", nil)
	b.Publish("a.b.c", nil)
	if n != 2 {
		t.Errorf("* matched %d topics, want 2", n)
	}
}

func TestPartialSegmentIsLiteral(t *testing.T) {
	b := New()
	var n int
	b.Subscribe("user.cre*", func(string, any) error { n++; return nil })
	b.Publish("user.created", nil)
	if n != 0 {
		t.Errorf("user.cre* matched user.created — partial wildcards must be literal topics")
	}
	b.Publish("user.cre*", nil)
	if n != 1 {
		t.Errorf("literal topic user.cre* not delivered to itself")
	}
}

func TestErrorIsolation(t *testing.T) {
	b := New()
	boom := errors.New("boom")
	var ran []string
	b.Subscribe("t", func(string, any) error { ran = append(ran, "a"); return boom })
	b.Subscribe("t", func(string, any) error { ran = append(ran, "b"); return nil })
	b.Subscribe("t", func(string, any) error { ran = append(ran, "c"); return boom })
	errs := b.Publish("t", nil)
	if strings.Join(ran, ",") != "a,b,c" {
		t.Errorf("a failing subscriber stopped others: ran %v", ran)
	}
	if len(errs) != 2 || !errors.Is(errs[0], boom) || !errors.Is(errs[1], boom) {
		t.Errorf("Publish errors = %v, want both booms", errs)
	}
}

func TestNoErrorsReturnsNil(t *testing.T) {
	b := New()
	b.Subscribe("t", func(string, any) error { return nil })
	if errs := b.Publish("t", nil); errs != nil {
		t.Errorf("all-success Publish = %v, want nil", errs)
	}
	if errs := b.Publish("nomatch", nil); errs != nil {
		t.Errorf("no-match Publish = %v, want nil", errs)
	}
}

func TestUnsubscribe(t *testing.T) {
	b := New()
	var n int
	unsub := b.Subscribe("t", func(string, any) error { n++; return nil })
	b.Publish("t", nil)
	unsub()
	unsub() // second call safe
	b.Publish("t", nil)
	if n != 1 {
		t.Errorf("handler called %d times after unsubscribe, want 1", n)
	}
}

func TestUnsubscribeOnlyOwnSubscription(t *testing.T) {
	b := New()
	var a, c int
	b.Subscribe("t", func(string, any) error { a++; return nil })
	unsubB := b.Subscribe("t", func(string, any) error { return nil })
	b.Subscribe("t", func(string, any) error { c++; return nil })
	unsubB()
	b.Publish("t", nil)
	if a != 1 || c != 1 {
		t.Errorf("unsubscribing b removed others: a=%d c=%d, want 1/1", a, c)
	}
}

func TestNilSubscriberIgnored(t *testing.T) {
	b := New()
	unsub := b.Subscribe("t", nil)
	unsub() // must not panic
	if errs := b.Publish("t", nil); errs != nil {
		t.Errorf("nil subscriber produced errors: %v", errs)
	}
}
