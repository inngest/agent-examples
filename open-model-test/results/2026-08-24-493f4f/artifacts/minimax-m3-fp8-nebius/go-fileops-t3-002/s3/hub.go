package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine. Concurrent use is not
// supported.
type Bus struct {
	subs []subscription
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

// Subscribe registers fn for the given topic pattern and returns an
// unsubscribe closure that removes exactly that subscription. Calling
// the returned closure more than once is safe; subsequent calls are
// no-ops. A nil fn is ignored and yields a no-op unsubscribe.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}
	sub := subscription{
		pattern: topic,
		segs:    splitDots(topic),
		fn:      fn,
	}
	b.subs = append(b.subs, sub)
	idx := len(b.subs) - 1
	return func() {
		b.unsubscribe(idx)
	}
}

func (b *Bus) unsubscribe(idx int) {
	// Mark the slot as removed by clearing its function. We keep the
	// entry in place so that any in-flight Publish that already
	// captured the slice is unaffected, but future Publish calls will
	// skip it.
	if idx < 0 || idx >= len(b.subs) {
		return
	}
	if b.subs[idx].fn == nil {
		return
	}
	b.subs[idx].fn = nil
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order. Errors from individual
// subscribers are collected and returned; nil entries are omitted. If
// no subscriber returns an error, the result is nil. Publish itself
// never panics because of a subscriber error.
func (b *Bus) Publish(topic string, payload any) []error {
	tSegs := splitDots(topic)
	var errs []error
	for i := range b.subs {
		sub := &b.subs[i]
		if sub.fn == nil {
			continue
		}
		if !matchPattern(sub.segs, tSegs) {
			continue
		}
		err := safeCall(sub.fn, topic, payload)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// safeCall invokes fn and converts any panic into an error so that
// Publish itself never panics because of a subscriber.
func safeCall(fn Subscriber, topic string, payload any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = panicError{value: r}
			}
		}
	}()
	return fn(topic, payload)
}

type panicError struct{ value any }

func (p panicError) Error() string {
	return "subscriber panic"
}

// matchPattern reports whether a topic (split into segments) matches a
// pattern (also split into segments). A "*" segment in the pattern
// matches exactly one segment in the topic. The pattern "*" alone
// matches any topic regardless of segment count.
func matchPattern(pattern, topic []string) bool {
	// Lone "*" matches every topic.
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

// splitDots splits s on '.' into a slice of segments. An empty string
// yields a single empty segment.
func splitDots(s string) []string {
	if s == "" {
		return []string{""}
	}
	return strings.Split(s, ".")
}
