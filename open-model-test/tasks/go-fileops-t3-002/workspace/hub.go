package bus

// Bus routes published topics to matching subscribers.
type Bus struct{}

// New creates an empty Bus.
//
// TODO: implement the real hub (matching, ordering, error isolation)
// per the task contract.
func New() *Bus {
	return &Bus{}
}

// Subscribe registers fn for topic and returns its unsubscribe closure.
func (b *Bus) Subscribe(topic string, fn Subscriber) func() {
	return func() {}
}

// Publish synchronously dispatches payload to matching subscribers.
func (b *Bus) Publish(topic string, payload any) []error {
	return nil
}
