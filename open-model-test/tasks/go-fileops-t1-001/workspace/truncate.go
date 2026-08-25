// Package strkit holds small string helpers.
package strkit

import "fmt"

// Truncate shortens s to at most n characters, appending an ellipsis when
// shortening occurred.
func Truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Elide is a placeholder for a future widening helper; do not change it.
func Elide(s string, n int) string {
	return fmt.Sprintf("%.*s…", n, s)
}
