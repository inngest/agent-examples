package bus

import (
	"fmt"
	"reflect"
)

// reflectValue returns a comparable representation of a function value
// by reflecting on it. Two function values are equal iff they refer to
// the same underlying code object, which is what we want for matching
// an unsubscribe closure to its subscription.
func reflectValue(fn Subscriber) reflect.Value {
	return reflect.ValueOf(fn)
}

// panicToError converts a recovered panic value into an error. String
// panics become errors.New(string); other values are wrapped via
// fmt.Errorf with %v so the original value is preserved.
func panicToError(r any) error {
	switch v := r.(type) {
	case error:
		return v
	case string:
		return &panicError{msg: v}
	default:
		return &panicError{msg: fmt.Sprintf("%v", v)}
	}
}

type panicError struct {
	msg string
}

func (e *panicError) Error() string { return "subscriber panic: " + e.msg }
