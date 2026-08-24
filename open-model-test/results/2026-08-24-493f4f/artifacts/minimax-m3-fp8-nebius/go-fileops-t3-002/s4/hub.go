package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine. Concurrent use is not
// supported; callers must serialize access themselves.
type Bus struct {
	subs []*subscription
}

type subscription struct {
	pattern string
	segs    []string
	fn      Subscriber
	removed bool
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for the given topic pattern and returns an
// unsubscribe closure that removes exactly this subscription. Calling
// the closure more than once is safe; subsequent calls are no-ops.
//
// A nil fn is ignored and a no-op unsubscribe is returned.
//
// Patterns are dot-separated segments. A segment equal to "*" is a
// single-segment wildcard. The pattern "*" alone matches every topic.
// Wildcards only match a complete segment; partial wildcards such as
// "user.cre*" are treated as literal segments.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}
	sub := &subscription{
		pattern: topic,
		segs:    splitSegments(topic),
		fn:      fn,
	}
	b.subs = append(b.subs, sub)
	return func() {
		if sub.removed {
			return
		}
		sub.removed = true
		for i, s := range b.subs {
			if s == sub {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				return
			}
		}
	}
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order.
//
// Matching follows the rules described on Subscribe. A subscriber that
// returns an error does not prevent later subscribers from being
// invoked; every non-nil error is collected into the returned slice.
// Publish itself never panics due to a subscriber error.
//
// Publish returns nil when there are no matches or when no subscriber
// returned an error.
func (b *Bus) Publish(topic string, payload any) []error {
	pubSegs := splitSegments(topic)
	var errs []error
	for _, s := range b.subs {
		if match(pubSegs, s.segs) {
			if err := safeCall(s.fn, topic, payload); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errs
}

// safeCall invokes fn and recovers from any panic, returning the panic
// value as an error so that one misbehaving subscriber cannot break
// delivery to the rest.
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

// splitSegments splits a dot-separated topic into its segments.
func splitSegments(topic string) []string {
	return strings.Split(topic, ".")
}

// match reports whether a published topic (given as segments) matches
// a subscription pattern (also given as segments). A "*" segment in the
// pattern matches exactly one segment of any value. The pattern "*"
// alone (a single segment) matches any topic.
func match(pubSegs, patSegs []string) bool {
	if len(patSegs) == 1 && patSegs[0] == "*" {
		return true
	}
	if len(pubSegs) != len(patSegs) {
		return false
	}
	for i, p := range patSegs {
		if p == "*" {
			continue
		}
		if p != pubSegs[i] {
			return false
		}
	}
	return true
}
