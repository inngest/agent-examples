package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine. Concurrent use is not
// supported by the contract.
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

// Subscribe registers fn for topic and returns its unsubscribe closure.
//
// A nil fn is ignored and a no-op unsubscribe is returned. Calling the
// returned unsubscribe more than once is safe; subsequent calls are
// no-ops.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}
	sub := &subscription{
		pattern: topic,
		segs:    strings.Split(topic, "."),
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
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				return
			}
		}
	}
}

// Publish synchronously dispatches payload to all matching subscribers
// in subscription order.
//
// Errors from individual subscribers are collected; a subscriber error
// does not stop other subscribers. Nil entries are skipped from the
// returned slice. Publish returns nil when there are no matches or no
// errors.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegs := strings.Split(topic, ".")
	var errs []error
	for _, s := range b.subs {
		if match(s.segs, topicSegs) {
			if err := s.fn(topic, payload); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errs
}

// match reports whether a subscription pattern matches a concrete topic.
// Both are dot-separated segment slices. A "*" segment in the pattern
// matches exactly one segment of any value. The lone "*" pattern matches
// any topic of any length. Patterns and topics must have the same
// number of segments to match, except for the lone "*" pattern which
// matches any topic.
func match(pattern, topic []string) bool {
	// Lone "*" pattern matches any topic.
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
