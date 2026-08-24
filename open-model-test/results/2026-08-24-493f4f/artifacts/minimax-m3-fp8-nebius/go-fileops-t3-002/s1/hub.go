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
// returned closure more than once is safe; only the first call removes
// the subscription.
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
// Errors from individual subscribers are collected and returned; nil
// entries are omitted. Publish itself never panics due to a subscriber
// error. If no subscriber matches or no subscriber returns an error,
// the returned slice is nil.
func (b *Bus) Publish(topic string, payload any) []error {
	b.mu.Lock()
	// Snapshot subscribers so unsubscribes during dispatch don't
	// affect this Publish's iteration. Per the contract, an
	// unsubscribed handler may still be called for an in-flight
	// Publish; we honour that by snapshotting.
	subs := make([]subscription, len(b.subs))
	copy(subs, b.subs)
	b.mu.Unlock()

	var errs []error
	for _, s := range subs {
		if !match(s.topic, topic) {
			continue
		}
		if err := safeCall(s.fn, topic, payload); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// safeCall invokes fn and recovers from any panic, returning the panic
// value as an error so Publish never propagates a subscriber panic.
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

type panicError struct {
	value any
}

func (p panicError) Error() string {
	return "subscriber panic"
}

// match reports whether pattern (which may contain single-segment
// wildcards) matches topic. Both pattern and topic are dot-separated
// segments. A "*" segment matches any single segment; "*" alone
// matches any topic. Wildcards only match one segment and only as a
// complete segment.
func match(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}

	// Fast path: identical strings.
	if pattern == topic {
		return true
	}

	// Segment-by-segment comparison.
	pi, ti := 0, 0
	for pi < len(pattern) && ti < len(topic) {
		// Read one segment from pattern.
		pend := indexByteFrom(pattern, pi, '.')
		pseg := pattern[pi:pend]

		// Read one segment from topic.
		tend := indexByteFrom(topic, ti, '.')
		tseg := topic[ti:tend]

		if pseg == "*" {
			// Wildcard matches exactly one segment; nothing more.
		} else if pseg != tseg {
			return false
		}

		// Advance past the segment.
		if pend < len(pattern) {
			pi = pend + 1
		} else {
			pi = pend
		}
		if tend < len(topic) {
			ti = tend + 1
		} else {
			ti = tend
		}
	}

	// Both must be fully consumed for a match.
	return pi == len(pattern) && ti == len(topic)
}

// indexByteFrom returns the index of c in s starting at offset, or
// len(s) if c is not present.
func indexByteFrom(s string, offset int, c byte) int {
	for i := offset; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return len(s)
}
