package bus

import "strings"

// subscription represents a single registered handler for a topic
// pattern. It is stored by pointer so that the unsubscribe closure can
// deactivate it in place without disturbing slice ordering/indices.
type subscription struct {
	pattern string
	fn      Subscriber
	active  bool
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
// A nil fn is ignored and results in a no-op unsubscribe function.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	sub := &subscription{
		pattern: topic,
		fn:      fn,
		active:  true,
	}
	b.subs = append(b.subs, sub)

	unsubscribed := false
	return func() {
		if unsubscribed {
			return
		}
		unsubscribed = true
		sub.active = false
	}
}

// Publish synchronously dispatches payload to matching subscribers, in
// the order they were subscribed. Errors returned by subscribers do not
// stop dispatch to the remaining subscribers; all non-nil errors are
// collected and returned. Publish returns nil if there are no matches
// or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegs := strings.Split(topic, ".")

	var errs []error
	for _, sub := range b.subs {
		if !sub.active {
			continue
		}
		if !matches(sub.pattern, topicSegs) {
			continue
		}
		if err := sub.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// matches reports whether pattern matches the already-split topic
// segments. The bare wildcard "*" matches any topic regardless of how
// many segments it has. Otherwise, each pattern segment must either
// equal the corresponding topic segment exactly or be the wildcard "*",
// matching exactly one segment; the number of segments must match.
func matches(pattern string, topicSegs []string) bool {
	if pattern == "*" {
		return true
	}

	patternSegs := strings.Split(pattern, ".")
	if len(patternSegs) != len(topicSegs) {
		return false
	}
	for i, ps := range patternSegs {
		if ps == "*" {
			continue
		}
		if ps != topicSegs[i] {
			return false
		}
	}
	return true
}
