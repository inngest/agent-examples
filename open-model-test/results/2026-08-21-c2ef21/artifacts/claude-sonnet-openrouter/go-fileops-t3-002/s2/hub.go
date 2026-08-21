package bus

import "strings"

// subscription represents a single registered subscriber.
type subscription struct {
	id      uint64
	pattern string
	fn      Subscriber
}

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine only.
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
// topic may contain "*" segments which are treated as wildcards when
// matching against published topics. A nil fn is ignored; Subscribe
// returns a no-op unsubscribe function in that case.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	b.nextID++
	sub := &subscription{
		id:      b.nextID,
		pattern: topic,
		fn:      fn,
	}
	b.subs = append(b.subs, sub)

	removed := false
	return func() {
		if removed {
			return
		}
		removed = true
		for i, s := range b.subs {
			if s == sub {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				break
			}
		}
	}
}

// Publish synchronously dispatches payload to matching subscribers in
// subscription order. Errors returned by subscribers do not stop other
// subscribers from being invoked; all non-nil errors are collected and
// returned. Publish returns nil if there are no matches or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	var errs []error

	// Snapshot the subscriber list so that unsubscribing during a
	// Publish (from within a subscriber) doesn't affect this dispatch
	// beyond what's explicitly guaranteed.
	subs := make([]*subscription, len(b.subs))
	copy(subs, b.subs)

	for _, s := range subs {
		if !matchTopic(s.pattern, topic) {
			continue
		}
		if err := s.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// matchTopic reports whether pattern matches topic, where pattern may
// contain "*" as a full segment to match any single segment. A pattern
// of exactly "*" matches every topic, regardless of how many segments
// the topic has.
func matchTopic(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}

	pSegs := strings.Split(pattern, ".")
	tSegs := strings.Split(topic, ".")

	if len(pSegs) != len(tSegs) {
		return false
	}

	for i, p := range pSegs {
		if p == "*" {
			continue
		}
		if p != tSegs[i] {
			return false
		}
	}

	return true
}
