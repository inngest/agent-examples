package bus

import "strings"

// subscription represents a single registered handler.
type subscription struct {
	pattern string
	fn      Subscriber
	removed bool
}

// Bus routes published topics to matching subscribers.
type Bus struct {
	subs []*subscription
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
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

// Publish synchronously dispatches payload to matching subscribers.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegs := strings.Split(topic, ".")

	var errs []error
	for _, sub := range b.subs {
		if sub.removed {
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

// matches reports whether pattern matches the given topic segments.
func matches(pattern string, topicSegs []string) bool {
	// A lone "*" matches every topic, regardless of segment count.
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
