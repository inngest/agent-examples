package bus

import "strings"

// subscription represents a single registered handler for a topic
// pattern, in the order it was subscribed.
type subscription struct {
	id      uint64
	pattern string
	fn      Subscriber
}

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine only.
type Bus struct {
	subs   []subscription
	nextID uint64
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
// Calling the returned closure more than once is safe (subsequent calls
// are no-ops). A nil subscriber is ignored and a no-op unsubscribe is
// returned.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	id := b.nextID
	b.nextID++

	b.subs = append(b.subs, subscription{
		id:      id,
		pattern: topic,
		fn:      fn,
	})

	removed := false
	return func() {
		if removed {
			return
		}
		removed = true
		for i, s := range b.subs {
			if s.id == id {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				break
			}
		}
	}
}

// Publish synchronously dispatches payload to matching subscribers in
// subscription order. Subscriber errors are isolated: one erroring
// subscriber does not prevent the others from being called. It returns
// nil if there were no matches or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	var errs []error

	// Copy the slice header so unsubscribing during dispatch (from
	// within a subscriber) doesn't affect this in-flight iteration in
	// surprising ways beyond what's specified.
	subs := b.subs

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

// matchTopic reports whether pattern matches topic. Patterns are
// dot-separated segments where a segment that is exactly "*" matches any
// single segment of topic. The pattern "*" alone matches every topic
// regardless of how many segments it has.
func matchTopic(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}

	if pattern == topic {
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
