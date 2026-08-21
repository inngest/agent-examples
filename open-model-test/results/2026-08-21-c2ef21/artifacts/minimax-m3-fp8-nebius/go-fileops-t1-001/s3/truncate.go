// Package strkit holds small string helpers.
package strkit

import (
	"fmt"
	"unicode/utf8"
)

// Truncate shortens s to at most n runes, appending an ellipsis when
// shortening occurred.
func Truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n]) + "…"
}

// Elide is a placeholder for a future widening helper; do not change it.
func Elide(s string, n int) string {
	return fmt.Sprintf("%.*s…", n, s)
}
