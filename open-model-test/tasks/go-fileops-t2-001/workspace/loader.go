// Package loader lazily loads values from a source function.
package loader

// Source produces the value for a key. It may fail; failures are part of
// the contract (see the caching policy in the task).
type Source func(key string) (string, error)

// Loader caches values from a Source.
type Loader struct {
	src Source
}

// New builds a Loader over src.
func New(src Source) *Loader {
	return &Loader{src: src}
}

// Get returns the value for key. TODO: add the caching policy described in
// the task — currently every Get calls the source.
func (l *Loader) Get(key string) (string, error) {
	return l.src(key)
}
