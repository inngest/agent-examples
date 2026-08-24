package slug

import (
	"strings"
	"unicode"
)

// Slugify converts arbitrary text into a URL slug according to the rules:
//   - ASCII letters are lowercased.
//   - ASCII letters and digits are kept.
//   - Non-ASCII runes (>= U+0080) are dropped.
//   - Runs of spaces, tabs, underscores, and hyphens each collapse into a single '-'.
//   - Other ASCII symbols/punctuation are dropped without leaving a separator.
//   - Leading and trailing separators are trimmed.
//   - The empty string (or input that drops/collapses to nothing) yields "".
func Slugify(s string) string {
	var b strings.Builder
	b.Grow(len(s))

	prevSep := false // tracks whether the previous emitted char was a separator

	for _, r := range s {
		if r >= 0x80 {
			// Non-ASCII runes are dropped entirely.
			continue
		}

		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
			prevSep = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
			prevSep = false
		case r >= '0' && r <= '9':
			b.WriteRune(r)
			prevSep = false
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if !prevSep {
				b.WriteByte('-')
				prevSep = true
			}
		default:
			// Other ASCII symbols/punctuation: drop without leaving a separator.
			// prevSep is left unchanged so that a separator run is not broken
			// by an intervening dropped symbol.
		}
	}

	out := b.String()
	// Trim a single trailing separator if present.
	if len(out) > 0 && out[len(out)-1] == '-' {
		out = out[:len(out)-1]
	}
	return out
}

// Keep unicode import referenced for clarity; not used at runtime.
var _ = unicode.IsSpace
