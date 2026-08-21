// Package loader lazily loads values from a source function.
package loader

import "errors"

// Source produces the value for a key. It may fail; failures are part of
// the contract (see the caching policy in the task).
type Source func(key string) (string, error)

// Loader caches values from a Source.
type Loader struct {
	src   Source
	cache map[string]string
}

// New builds a Loader over src. A nil src is permitted; Get on the
// resulting Loader returns an error for any key and never panics.
func New(src Source) *Loader {
	return &Loader{src: src, cache: make(map[string]string)}
}

// Get returns the value for key. A successful source result (value, nil)
// is cached for the key, so subsequent Get calls for the same key return
// the cached value without invoking the source. A failed source result
// (_, err) is not cached; the next Get for that key will call the source
// again.
func (l *Loader) Get(key string) (string, error) {
	if l.src == nil {
		return "", errors.New("loader: source is nil")
	}
	if v, ok := l.cache[key]; ok {
		return v, nil
	}
	v, err := l.src(key)
	if err != nil {
		return "", err
	}
	l.cache[key] = v
	return v, nil
}
