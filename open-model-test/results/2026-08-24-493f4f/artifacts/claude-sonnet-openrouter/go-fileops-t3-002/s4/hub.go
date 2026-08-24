package bus

import "strings"

// subscription represents a single registered subscriber.
type subscription struct {
	pattern []string
	fn      Subscriber
	active  bool
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
		pattern: strings.Split(topic, "."),
		fn:      fn,
		active:  true,
	}
	b.subs = append(b.subs, sub)

	return func() {
		sub.active = false
	}
}

// Publish synchronously dispatches payload to matching subscribers.
func (b *Bus) Publish(topic string, payload any) []error {
	segments := strings.Split(topic, ".")

	var errs []error
	for _, sub := range b.subs {
		if !sub.active {
			continue
		}
		if !matches(sub.pattern, segments) {
			continue
		}
		if err := sub.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// matches reports whether the given pattern segments match the topic
// segments, where "*" in a pattern segment matches exactly one segment.
// A pattern consisting solely of "*" matches every topic regardless of
// its number of segments.
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
