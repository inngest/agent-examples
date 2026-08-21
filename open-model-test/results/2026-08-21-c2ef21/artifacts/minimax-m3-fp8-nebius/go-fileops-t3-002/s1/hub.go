package bus

import "sync"

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine. Concurrent use is not
// supported; callers must serialize access externally.
type Bus struct {
	mu   sync.Mutex
	subs []*subscription
}

// subscription is a single registered handler.
type subscription struct {
	pattern string
	segs    []string
	fn      Subscriber
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for the given topic pattern and returns a
// closure that removes exactly that subscription. Calling the returned
// closure more than once is safe; subsequent calls are no-ops.
//
// A nil fn is ignored and a no-op unsubscribe is returned.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	segs := splitTopic(topic)
	sub := &subscription{
		pattern: topic,
		segs:    segs,
		fn:      fn,
	}

	b.mu.Lock()
	b.subs = append(b.subs, sub)
	b.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			for i, s := range b.subs {
				if s == sub {
					// Compact the slice to preserve order.
					b.subs = append(b.subs[:i], b.subs[i+1:]...)
					return
				}
			}
		})
	}
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order.
//
// Matching rules:
//   - "*" alone matches every topic.
//   - A "*" segment matches exactly one segment of the published topic.
//   - All other segments must match literally.
//
// Errors from individual subscribers are collected and returned. A
// subscriber returning an error does not prevent later subscribers from
// being invoked. nil entries are omitted from the returned slice. If no
// subscriber matches or no subscriber returns an error, the result is
// nil.
//
// Publish never panics because of a subscriber error.
func (b *Bus) Publish(topic string, payload any) []error {
	pubSegs := splitTopic(topic)

	b.mu.Lock()
	// Snapshot the current subscription list so that unsubscribes
	// during dispatch do not affect iteration of this Publish call.
	subs := make([]*subscription, len(b.subs))
	copy(subs, b.subs)
	b.mu.Unlock()

	var errs []error
	for _, s := range subs {
		if matchSegments(s.segs, pubSegs) {
			if err := safeInvoke(s.fn, topic, payload); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errs
}

// safeInvoke calls fn and recovers from any panic, returning the
// recovered value as an error so that one misbehaving subscriber cannot
// disrupt the rest of the dispatch.
func safeInvoke(fn Subscriber, topic string, payload any) (err error) {
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

// panicError wraps a non-error panic value so it satisfies the error
// interface.
type panicError struct{ value any }

func (p panicError) Error() string {
	return "subscriber panic"
}

// splitTopic splits a dot-separated topic into its segments. An empty
// topic yields a single empty segment so that "*" alone still matches.
func splitTopic(topic string) []string {
	if topic == "" {
		return []string{""}
	}
	// Count segments to allocate exactly once.
	n := 1
	for i := 0; i < len(topic); i++ {
		if topic[i] == '.' {
			n++
		}
	}
	segs := make([]string, 0, n)
	start := 0
	for i := 0; i < len(topic); i++ {
		if topic[i] == '.' {
			segs = append(segs, topic[start:i])
			start = i + 1
		}
	}
	segs = append(segs, topic[start:])
	return segs
}

// matchSegments reports whether a pattern (already split into segments)
// matches a published topic (also split into segments).
//
// Rules:
//   - "*" alone (single segment equal to "*") matches any topic.
//   - Otherwise, segment counts must match.
//   - A "*" segment matches exactly one segment of any value.
//   - All other segments must be equal.
func matchSegments(pattern, topic []string) bool {
	if len(pattern) == 1 && pattern[0] == "*" {
		return true
	}
	if len(pattern) != len(topic) {
		return false
	}
	for i, seg := range pattern {
		if seg == "*" {
			continue
		}
		if seg != topic[i] {
			return false
		}
	}
	return true
}
