package bus

import "strings"

// subscription holds a single registered handler along with the
// pre-split pattern segments used for matching.
type subscription struct {
	id       uint64
	segments []string
	// matchAll is true when the pattern is the lone wildcard "*",
	// which matches every topic regardless of segment count.
	matchAll bool
	fn       Subscriber
}

// Bus routes published topics to matching subscribers.
//
// Bus is not safe for concurrent use from multiple goroutines; it is
// intended for single-goroutine use as documented.
type Bus struct {
	subs   []*subscription
	nextID uint64
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
// A nil fn is ignored and a no-op unsubscribe function is returned.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	b.nextID++
	id := b.nextID

	sub := &subscription{
		id:       id,
		segments: strings.Split(topic, "."),
		matchAll: topic == "*",
		fn:       fn,
	}
	b.subs = append(b.subs, sub)

	return func() {
		for i, s := range b.subs {
			if s.id == id {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				return
			}
		}
	}
}

// Publish synchronously dispatches payload to matching subscribers in
// subscription order. Errors from individual subscribers are isolated:
// one subscriber's error does not prevent others from running, and all
// non-nil errors are collected into the returned slice.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegments := strings.Split(topic, ".")

	var errs []error
	// Snapshot the current subscribers so that unsubscribing during
	// dispatch (from within a handler) does not affect this in-flight
	// publish's iteration in surprising ways.
	subs := make([]*subscription, len(b.subs))
	copy(subs, b.subs)

	for _, s := range subs {
		if !s.matchAll && !matchSegments(s.segments, topicSegments) {
			continue
		}
		if err := s.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// matchSegments reports whether pattern matches topic segments, where a
// pattern segment of "*" matches exactly one arbitrary topic segment.
func matchSegments(pattern, topic []string) bool {
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
