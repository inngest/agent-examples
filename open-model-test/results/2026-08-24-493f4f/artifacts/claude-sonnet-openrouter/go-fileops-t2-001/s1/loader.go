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

// New builds a Loader over src.
func New(src Source) *Loader {
	return &Loader{src: src, cache: make(map[string]string)}
}

// Get returns the value for key, caching successful results. Failed
// results are not cached and will cause the source to be called again on
// the next Get for the same key.
func (l *Loader) Get(key string) (string, error) {
	if v, ok := l.cache[key]; ok {
		return v, nil
	}

	if l.src == nil {
		return "", errors.New("loader: no source configured")
	}

	v, err := l.src(key)
	if err != nil {
		return "", err
	}

	l.cache[key] = v
	return v, nil
}
