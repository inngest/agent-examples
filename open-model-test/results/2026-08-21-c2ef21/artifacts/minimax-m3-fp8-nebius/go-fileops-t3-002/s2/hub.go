package bus

import "sync"

// Bus routes published topics to matching subscribers.
//
// Bus is safe for use from a single goroutine. Concurrent use is not
// supported by the contract.
type Bus struct {
	mu     sync.Mutex
	subs   []subscription
	nextID uint64
}

type subscription struct {
	id    uint64
	topic string
	fn    Subscriber
}

// New creates an empty Bus.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
//
// A nil fn is ignored and a no-op unsubscribe is returned. Calling the
// returned closure more than once is safe; only the first call has an
// effect.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	if fn == nil {
		return func() {}
	}

	b.mu.Lock()
	b.nextID++
	id := b.nextID
	b.subs = append(b.subs, subscription{
		id:    id,
		topic: topic,
		fn:    fn,
	})
	b.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			for i, s := range b.subs {
				if s.id == id {
					b.subs = append(b.subs[:i], b.subs[i+1:]...)
					return
				}
			}
		})
	}
}

// Publish synchronously dispatches payload to every subscriber whose
// topic pattern matches topic, in subscription order.
//
// Matching rules:
//   - "*" alone matches every topic.
//   - Otherwise, the pattern and topic must have the same number of
//     dot-separated segments, and each segment must be either equal or
//     the literal "*".
//
// A subscriber returning an error does not stop the remaining
// subscribers from being invoked. Every non-nil error is collected and
// returned in the order the matching subscribers were registered.
// Publish itself never panics due to a subscriber error. If there are
// no matches, or no subscriber returned an error, the result is nil.
func (b *Bus) Publish(topic string, payload any) []error {
	b.mu.Lock()
	// Snapshot the current subscribers so that an unsubscribe during
	// dispatch does not affect this Publish call. The contract only
	// guarantees that an unsubscribed handler is not called by future
	// Publish calls, so this snapshot is permitted.
	snapshot := make([]subscription, len(b.subs))
	copy(snapshot, b.subs)
	b.mu.Unlock()

	var errs []error
	for _, s := range snapshot {
		if !match(s.topic, topic) {
			continue
		}
		if err := safeCall(s.fn, topic, payload); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// safeCall invokes fn and recovers from any panic it raises, returning
// the panic value as an error so that one misbehaving subscriber cannot
// take down the whole Publish.
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

// match reports whether pattern matches topic under the bus's wildcard
// rules. Both inputs are dot-separated segments; "*" matches any single
// segment, and "*" alone matches any topic.
func match(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}
	pSegs := splitSegments(pattern)
	tSegs := splitSegments(topic)
	if len(pSegs) != len(tSegs) {
		return false
	}
	for i, p := range pSegs {
		if p == "*" {
			continue
		}
		if p != tSegs[i] {
			return false
		}
	}
	return true
}

// splitSegments splits s on '.'. An empty string yields a single empty
// segment so that "user" and "user." are distinguishable from "".
func splitSegments(s string) []string {
	if s == "" {
		return []string{""}
	}
	out := make([]string, 0, 4)
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
