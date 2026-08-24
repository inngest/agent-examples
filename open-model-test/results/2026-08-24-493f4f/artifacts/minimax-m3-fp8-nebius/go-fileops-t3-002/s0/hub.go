package bus

import "strings"

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine. It is not safe for
// concurrent use.
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
// the closure more than once is safe; subsequent calls are no-ops.
//
// A nil fn is ignored and a no-op unsubscribe is returned.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	segs := splitTopic(topic)
	sub := subscription{
		pattern: topic,
		segs:    segs,
		fn:      fn,
	}
	b.subs = append(b.subs, sub)

	idx := len(b.subs) - 1
	var unsubscribed bool
	return func() {
		if unsubscribed {
			return
		}
		unsubscribed = true
		b.removeAt(idx)
	}
}

// removeAt removes the subscription at idx, preserving the order of
// remaining subscriptions.
func (b *Bus) removeAt(idx int) {
	if idx < 0 || idx >= len(b.subs) {
		return
	}
	b.subs = append(b.subs[:idx], b.subs[idx+1:]...)
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order.
//
// Errors from individual subscribers are collected and returned. A
// subscriber returning an error does not prevent later subscribers
// from being called. nil entries in the returned slice are skipped.
// Publish returns nil when there are no matches or no errors.
func (b *Bus) Publish(topic string, payload any) []error {
	if len(b.subs) == 0 {
		return nil
	}

	tSegs := splitTopic(topic)
	var errs []error

	for _, sub := range b.subs {
		if !match(sub.segs, tSegs) {
			continue
		}
		// Subscriber errors must not stop dispatch and must not panic
		// the caller. A panic from a subscriber is recovered and
		// converted into an error so other subscribers still run.
		err := safeCall(sub.fn, topic, payload)
		if err != nil {
			errs = append(errs, err)
		}
	}

	return errs
}

// safeCall invokes fn with recover so a panicking subscriber cannot
// take down Publish.
func safeCall(fn Subscriber, topic string, payload any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			switch e := r.(type) {
			case error:
				err = e
			default:
				err = panicError{value: e}
			}
		}
	}()
	return fn(topic, payload)
}

// panicError wraps a non-error value recovered from a panicking
// subscriber.
type panicError struct{ value any }

func (p panicError) Error() string {
	return "bus: subscriber panic: " + asString(p.value)
}

func asString(v any) string {
	if v == nil {
		return "<nil>"
	}
	if s, ok := v.(string); ok {
		return s
	}
	return "<non-string panic value>"
}

// splitTopic splits a topic into its dot-separated segments. A trailing
// empty segment from a trailing dot is preserved so that "a." has two
// segments ("a", ""), matching the literal semantics of the contract.
func splitTopic(topic string) []string {
	if topic == "" {
		return []string{""}
	}
	return strings.Split(topic, ".")
}

// match reports whether a parsed pattern matches a parsed topic.
// A pattern segment of "*" matches any single segment. Segments must
// match in count and position; "*" alone (a single-segment pattern
// consisting of just "*") matches any topic regardless of segment
// count.
func match(pattern, topic []string) bool {
	// Lone "*" pattern: a single segment that is "*" matches any topic.
	if len(pattern) == 1 && pattern[0] == "*" {
		return true
	}
	if len(pattern) != len(topic) {
		return false
	}
	for i, ps := range pattern {
		if ps == "*" {
			continue
		}
		if ps != topic[i] {
			return false
		}
	}
	return true
}
