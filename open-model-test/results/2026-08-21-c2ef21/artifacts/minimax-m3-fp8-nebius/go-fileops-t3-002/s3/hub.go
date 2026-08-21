package bus

import "sync"

// Bus routes published topics to matching subscribers.
//
// A Bus is safe for use from a single goroutine. Concurrent use is not
// supported by this implementation.
type Bus struct {
	mu   sync.Mutex
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
// returned closure more than once is safe; subsequent calls are no-ops.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	segs := splitTopic(topic)

	b.mu.Lock()
	idx := len(b.subs)
	b.subs = append(b.subs, subscription{
		pattern: topic,
		segs:    segs,
		fn:      fn,
	})
	b.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			for i, s := range b.subs {
				if i == idx && s.fn != nil {
					b.subs[i].fn = nil
					return
				}
			}
		})
	}
}

// Publish synchronously dispatches payload to every subscriber whose
// pattern matches topic, in subscription order.
//
// Errors from individual subscribers are collected and returned; nil
// entries are skipped. Publish returns nil when there are no matches or
// when no subscriber returned an error. Publish never panics due to a
// subscriber error.
func (b *Bus) Publish(topic string, payload any) []error {
	topicSegs := splitTopic(topic)

	b.mu.Lock()
	snapshot := make([]subscription, len(b.subs))
	copy(snapshot, b.subs)
	b.mu.Unlock()

	var errs []error
	for _, s := range snapshot {
		if s.fn == nil {
			continue
		}
		if !matchSegments(s.segs, topicSegs) {
			continue
		}
		err := safeInvoke(s.fn, topic, payload)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// safeInvoke calls fn and converts any panic into an error so that
// Publish never panics from subscriber code.
func safeInvoke(fn Subscriber, topic string, payload any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicError{value: r}
		}
	}()
	return fn(topic, payload)
}

type panicError struct{ value any }

func (p panicError) Error() string {
	return "subscriber panic"
}

// splitTopic splits a dot-separated topic into its segments. An empty
// topic yields a single empty segment so that "*" alone matches it.
func splitTopic(topic string) []string {
	if topic == "" {
		return []string{""}
	}
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

// matchSegments reports whether a pattern (with possible "*" segments)
// matches the topic segments. A "*" segment matches exactly one
// segment; "*" alone matches any single-segment topic.
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
