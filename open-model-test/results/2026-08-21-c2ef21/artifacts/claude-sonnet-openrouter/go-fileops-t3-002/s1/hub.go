package bus

import "strings"

// subscription represents a single registered subscriber.
type subscription struct {
	id      uint64
	topic   string
	fn      Subscriber
	removed bool
}

// Bus routes published topics to matching subscribers.
type Bus struct {
	subs   []*subscription
	nextID uint64
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
// A nil subscriber is ignored and a no-op unsubscribe is returned.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	b.nextID++
	sub := &subscription{
		id:    b.nextID,
		topic: topic,
		fn:    fn,
	}
	b.subs = append(b.subs, sub)

	unsubscribed := false
	return func() {
		if unsubscribed {
			return
		}
		unsubscribed = true
		sub.removed = true
	}
}

// Publish synchronously dispatches payload to matching subscribers, in
// subscription order. Errors from subscribers are collected and returned;
// a subscriber's error never prevents other subscribers from running.
func (b *Bus) Publish(topic string, payload any) []error {
	var errs []error

	for _, sub := range b.subs {
		if sub.removed {
			continue
		}
		if !topicMatches(sub.topic, topic) {
			continue
		}
		if err := sub.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// topicMatches reports whether the published topic matches the given
// subscription pattern. Patterns are dot-separated segments where "*"
// matches exactly one arbitrary segment. A pattern of exactly "*" (with
// no dots) matches every topic, regardless of how many segments it has.
func topicMatches(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}

	patSegs := strings.Split(pattern, ".")
	topSegs := strings.Split(topic, ".")

	if len(patSegs) != len(topSegs) {
		return false
	}

	for i, p := range patSegs {
		if p == "*" {
			continue
		}
		if p != topSegs[i] {
			return false
		}
	}

	return true
}
