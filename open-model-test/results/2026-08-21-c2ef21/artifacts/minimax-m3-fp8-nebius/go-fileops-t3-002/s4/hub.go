package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine. Concurrent use is not
// supported by the contract.
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

// Subscribe registers fn for topic and returns its unsubscribe closure.
//
// A nil fn is ignored and a no-op unsubscribe is returned. Calling the
// returned unsubscribe more than once is safe; only the first call has
// any effect.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}
	sub := subscription{
		pattern: topic,
		segs:    splitSegments(topic),
		fn:      fn,
	}
	b.subs = append(b.subs, sub)
	idx := len(b.subs) - 1
	return func() {
		// Guard against double-unsubscribe and against the slice having
		// been re-sliced by a prior unsubscribe of an earlier entry.
		if idx < 0 || idx >= len(b.subs) {
			return
		}
		if !sameSubscription(b.subs[idx], sub) {
			return
		}
		// Remove by zeroing the slot and shifting the tail down so that
		// previously captured indices remain valid for any unsubscribe
		// closures created before this one.
		copy(b.subs[idx:], b.subs[idx+1:])
		b.subs[len(b.subs)-1] = subscription{}
		b.subs = b.subs[:len(b.subs)-1]
		// Invalidate this closure's captured index so a second call is
		// a no-op.
		idx = -1
	}
}

func sameSubscription(a, b subscription) bool {
	return a.pattern == b.pattern && reflectValue(a.fn) == reflectValue(b.fn)
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order.
//
// A subscriber returning an error does not prevent later subscribers
// from being called. All non-nil errors are collected and returned in
// the order the matching subscribers were registered. If no subscriber
// returns an error, the result is nil.
//
// Publish itself never panics because of a subscriber error; a panicking
// subscriber is treated as an error and the panic is contained.
func (b *Bus) Publish(topic string, payload any) []error {
	tSegs := splitSegments(topic)
	var errs []error
	for i := range b.subs {
		sub := b.subs[i]
		if !matchSegments(sub.segs, tSegs) {
			continue
		}
		err := safeCall(sub.fn, topic, payload)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// safeCall invokes fn, converting any panic into an error so that one
// misbehaving subscriber cannot crash the publisher.
func safeCall(fn Subscriber, topic string, payload any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicToError(r)
		}
	}()
	return fn(topic, payload)
}

// splitSegments splits a dot-separated topic into its segments. An
// empty topic yields a single empty segment so that "*" still matches
// it.
func splitSegments(topic string) []string {
	if topic == "" {
		return []string{""}
	}
	return strings.Split(topic, ".")
}

// matchSegments reports whether a pattern's segments match a topic's
// segments. A "*" segment matches exactly one topic segment; the
// pattern must have the same number of segments as the topic.
func matchSegments(pattern, topic []string) bool {
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
