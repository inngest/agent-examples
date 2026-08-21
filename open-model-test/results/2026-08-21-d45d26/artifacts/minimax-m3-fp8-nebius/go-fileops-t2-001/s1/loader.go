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

// New builds a Loader over src. A nil src is permitted; Get on such a
// Loader returns an error for any key and never panics.
func New(src Source) *Loader {
	return &Loader{src: src}
}

// Get returns the value for key. Successful source results are cached for
// their key; failed results are not cached, so the next Get for that key
// will call the source again.
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
	if l.cache == nil {
		l.cache = make(map[string]string)
	}
	l.cache[key] = v
	return v, nil
}
