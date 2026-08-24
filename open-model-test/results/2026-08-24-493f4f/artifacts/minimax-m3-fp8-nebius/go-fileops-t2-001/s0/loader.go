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
// returns an error for any key without panicking.
func New(src Source) *Loader {
	return &Loader{src: src}
}

// Get returns the value for key. Successful results are cached; failures
// are not, so the next Get for the same key will retry the source.
func (l *Loader) Get(key string) (string, error) {
	if l.src == nil {
		return "", errors.New("loader: source is nil")
	}

	l.mu.Lock()
	if v, ok := l.cache[key]; ok {
		l.mu.Unlock()
		return v, nil
	}
	l.mu.Unlock()

	v, err := l.src(key)
	if err != nil {
		return "", err
	}

	l.mu.Lock()
	if l.cache == nil {
		l.cache = make(map[string]string)
	}
	l.cache[key] = v
	l.mu.Unlock()

	return v, nil
}
