// Package loader lazily loads values from a source function.
package loader

import (
	"errors"
	"sync"
)

// Source produces the value for a key. It may fail; failures are part of
// the contract (see the caching policy in the task).
type Source func(key string) (string, error)

// Loader caches values from a Source.
type Loader struct {
	src   Source
	mu    sync.Mutex
	cache map[string]string
}

// New builds a Loader over src. A nil src is permitted; in that case Get
// returns an error for any key and never panics.
func New(src Source) *Loader {
	return &Loader{src: src}
}

// Get returns the value for key. Successful source results are cached for
// their key; failed results are not cached, so the next Get for the same
// key will call the source again.
func (l *Loader) Get(key string) (string, error) {
	l.mu.Lock()
	if v, ok := l.cache[key]; ok {
		l.mu.Unlock()
		return v, nil
	}
	l.mu.Unlock()

	if l.src == nil {
		return "", errors.New("loader: source is nil")
	}

	value, err := l.src(key)
	if err != nil {
		return "", err
	}

	l.mu.Lock()
	if l.cache == nil {
		l.cache = make(map[string]string)
	}
	l.cache[key] = value
	l.mu.Unlock()

	return value, nil
}
