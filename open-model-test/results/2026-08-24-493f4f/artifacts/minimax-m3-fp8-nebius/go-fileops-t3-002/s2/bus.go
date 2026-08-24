// Package bus is a synchronous in-process publish/subscribe hub with
// single-segment wildcard topics.
package bus

// Subscriber receives a payload for a topic it matches.
type Subscriber func(topic string, payload any) error
