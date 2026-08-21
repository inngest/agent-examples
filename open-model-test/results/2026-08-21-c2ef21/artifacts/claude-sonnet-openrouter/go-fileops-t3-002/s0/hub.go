package bus

import "strings"

// subscription holds a single registered subscriber.
type subscription struct {
	id    uint64
	topic string
	segs  []string
	fn    Subscriber
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
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	b.nextID++
	id := b.nextID

	sub := &subscription{
		id:    id,
		topic: topic,
		segs:  strings.Split(topic, "."),
		fn:    fn,
	}
	b.subs = append(b.subs, sub)

	unsubscribed := false
	return func() {
		if unsubscribed {
			return
		}
		unsubscribed = true
		for i, s := range b.subs {
			if s.id == id {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				break
			}
		}
	}
}

// Publish synchronously dispatches payload to matching subscribers.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegs := strings.Split(topic, ".")

	// Snapshot subscribers to publish in subscription order, unaffected
	// by concurrent unsubscribes triggered from within handlers.
	subs := make([]*subscription, len(b.subs))
	copy(subs, b.subs)

	var errs []error
	for _, s := range subs {
		if !matches(s.segs, topicSegs) {
			continue
		}
		if err := s.fn(topic, payload); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// matches reports whether pattern segments match topic segments, where
// a pattern segment of "*" matches exactly one arbitrary topic segment.
// A lone "*" pattern (single segment) matches any topic regardless of
// how many segments the topic has.
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
