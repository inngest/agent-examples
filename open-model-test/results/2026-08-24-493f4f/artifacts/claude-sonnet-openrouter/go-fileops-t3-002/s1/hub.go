package bus

import "strings"

// subscription represents a single registered subscriber.
type subscription struct {
	id      uint64
	pattern []string
	fn      Subscriber
}

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine only.
type Bus struct {
	subs   []*subscription
	nextID uint64
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
//
// topic is a dot-separated pattern where each segment may be a literal
// or the wildcard "*", matching exactly one segment. The lone wildcard
// "*" matches every topic, regardless of how many segments it has.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	sub := &subscription{
		id:      b.nextID,
		pattern: strings.Split(topic, "."),
		fn:      fn,
	}
	b.nextID++
	b.subs = append(b.subs, sub)

	return func() {
		for i, s := range b.subs {
			if s == sub {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				return
			}
		}
	}
}

// Publish synchronously dispatches payload to matching subscribers in
// subscription order. Errors from individual subscribers do not stop
// dispatch to the others; all non-nil errors are returned. Publish
// returns nil when there are no matches or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	segments := strings.Split(topic, ".")

	// Copy the current subscriber list so that unsubscribes triggered by
	// a subscriber during this Publish do not affect the in-flight
	// dispatch.
	subs := make([]*subscription, len(b.subs))
	copy(subs, b.subs)

	var errs []error
	for _, s := range subs {
		if !matches(s.pattern, segments) {
			continue
		}
		if err := s.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// matches reports whether the given pattern segments match the topic
// segments, where "*" matches exactly one arbitrary segment. A lone
// wildcard pattern ("*") matches every topic regardless of its number
// of segments.
func matches(pattern, topic []string) bool {
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
