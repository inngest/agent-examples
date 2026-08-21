package bus

import "fmt"

// fmtSprintf is a tiny indirection over fmt.Sprintf so that the panic
// conversion code can stay in its own file.
func fmtSprintf(format string, args ...any) string {
	return fmt.Sprintf(format, args...)
}

// keep runtime referenced so the helper above is not flagged as unused
// by tooling that does not see the cross-file usage.
var _ = runtime.FuncForPC
