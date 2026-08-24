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

// Get returns the value for key. Successful results are cached; failed
// results are not cached, so a subsequent Get will retry the source.
func (l *Loader) Get(key string) (string, error) {
	if v, ok := l.cache[key]; ok {
		return v, nil
	}

	if l.src == nil {
		return "", errors.New("loader: nil source")
	}

	v, err := l.src(key)
	if err != nil {
		return "", err
	}

	if l.cache == nil {
		l.cache = make(map[string]string)
	}
	l.cache[key] = v

	return v, nil
}
