package bus

import "strings"

// subscription represents a single registered handler for a topic
// pattern. It is removed (tombstoned) rather than physically deleted
// from the bus's slice so that in-flight Publish calls are unaffected
// by concurrent Subscribe/Unsubscribe operations on the same slice
// index space.
type subscription struct {
	pattern string
	fn      Subscriber
	removed bool
}

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine only.
type Bus struct {
	subs []*subscription
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
// Calling the returned closure more than once is a no-op. A nil fn is
// ignored and results in a no-op unsubscribe.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	sub := &subscription{
		pattern: topic,
		fn:      fn,
	}
	b.subs = append(b.subs, sub)

	return func() {
		sub.removed = true
	}
}

// Publish synchronously dispatches payload to matching subscribers, in
// subscription order. Errors returned by subscribers are collected and
// returned; a subscriber's error never prevents other subscribers from
// running. Publish returns nil if there are no matches or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	segs := strings.Split(topic, ".")

	var errs []error
	// Snapshot the length so that subscriptions added during this
	// Publish (e.g. from within a subscriber callback) are not invoked
	// as part of this dispatch.
	n := len(b.subs)
	for i := 0; i < n; i++ {
		sub := b.subs[i]
		if sub.removed {
			continue
		}
		if !matchTopic(sub.pattern, segs) {
			continue
		}
		if err := sub.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// matchTopic reports whether the dot-separated pattern matches the
// already-split topic segments. Each pattern segment must either equal
// the corresponding topic segment exactly or be the wildcard "*",
// matching exactly one segment. The bare pattern "*" is a special case
// that matches every topic, regardless of how many segments it has.
func matchTopic(pattern string, segs []string) bool {
	if pattern == "*" {
		return true
	}

	patSegs := strings.Split(pattern, ".")
	if len(patSegs) != len(segs) {
		return false
	}
	for i, p := range patSegs {
		if p != "*" && p != segs[i] {
			return false
		}
	}
	return true
}
