package slug

import (
	"strings"
	"unicode"
)

// Slugify converts arbitrary text into a URL slug following the specified rules.
func Slugify(s string) string {
	var b strings.Builder
	b.Grow(len(s))

	prevSep := false

	for _, r := range s {
		// Drop non-ASCII runes entirely.
		if r >= 0x80 {
			continue
		}

		// ASCII letters: lowercase and keep.
		if r >= 'A' && r <= 'Z' {
			r = r + ('a' - 'A')
			b.WriteRune(r)
			prevSep = false
			continue
		}
		if r >= 'a' && r <= 'z' {
			b.WriteRune(r)
			prevSep = false
			continue
		}

		// ASCII digits: keep.
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
			prevSep = false
			continue
		}

		// Separators: space, tab, underscore, hyphen.
		if r == ' ' || r == '\t' || r == '_' || r == '-' {
			if !prevSep {
				b.WriteByte('-')
				prevSep = true
			}
			continue
		}

		// Other ASCII symbols/punctuation: dropped without leaving a separator.
		// (No action needed; prevSep unchanged.)
		_ = unicode.IsSpace // keep unicode import used if needed elsewhere; not required here
	}

	result := b.String()
	// Trim leading/trailing hyphens.
	result = strings.Trim(result, "-")
	return result
}
