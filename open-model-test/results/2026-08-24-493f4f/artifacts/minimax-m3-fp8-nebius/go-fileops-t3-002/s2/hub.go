package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine. It is not safe for
// concurrent use.
type Bus struct {
	subs []*subscription
}

type subscription struct {
	pattern string
	segs    []string
	fn      Subscriber
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for the given topic pattern and returns an
// unsubscribe closure. A nil fn is ignored and a no-op unsubscribe is
// returned. Calling the unsubscribe closure more than once is safe; the
// second and subsequent calls are no-ops.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}
	segs := splitSegments(topic)
	sub := &subscription{
		pattern: topic,
		segs:    segs,
		fn:      fn,
	}
	b.subs = append(b.subs, sub)
	var removed bool
	return func() {
		if removed {
			return
		}
		removed = true
		for i, s := range b.subs {
			if s == sub {
				b.removeAt(i)
				return
			}
		}
	}
}

func (b *Bus) removeAt(i int) {
	copy(b.subs[i:], b.subs[i+1:])
	b.subs[len(b.subs)-1] = nil
	b.subs = b.subs[:len(b.subs)-1]
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order. Errors from individual
// subscribers are collected and returned; nil entries are omitted. A
// subscriber returning an error does not prevent later subscribers from
// being called. Publish returns nil when there are no matches or when
// no subscriber returned an error.
func (b *Bus) Publish(topic string, payload any) []error {
	tSegs := splitSegments(topic)
	var errs []error
	// Snapshot the current subscriber list so that an unsubscribe
	// during dispatch does not affect iteration order or skip
	// subscribers that were already registered.
	snapshot := make([]*subscription, len(b.subs))
	copy(snapshot, b.subs)
	for _, s := range snapshot {
		if s == nil {
			continue
		}
		if match(s.segs, tSegs) {
			if err := safeCall(s.fn, topic, payload); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errs
}

// safeCall invokes fn and converts any panic into an error so that a
// misbehaving subscriber cannot crash the publisher.
func safeCall(fn Subscriber, topic string, payload any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = panicError{value: r}
			}
		}
	}()
	return fn(topic, payload)
}

type panicError struct{ value any }

func (p panicError) Error() string {
	return "bus: subscriber panic"
}

// match reports whether a pre-split pattern matches a pre-split topic.
// A "*" segment matches exactly one segment of any value. The lone
// "*" pattern matches every topic regardless of segment count.
func match(pattern, topic []string) bool {
	// Lone "*" matches any topic.
	if len(pattern) == 1 && pattern[0] == "*" {
		return true
	}
	if len(pattern) != len(topic) {
		return false
	}
	for i, p := range pattern {
		if p == "*" {
			continue
		}
		if p != topic[i] {
			return false
		}
	}
	return true
}

// splitSegments splits a dot-separated topic into its segments.
func splitSegments(s string) []string {
	return strings.Split(s, ".")
}
