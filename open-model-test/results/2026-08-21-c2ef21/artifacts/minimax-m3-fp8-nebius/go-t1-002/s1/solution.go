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

		// Convert ASCII letters to lowercase.
		if r >= 'A' && r <= 'Z' {
			r = r - 'A' + 'a'
		}

		// Keep ASCII letters and digits unchanged.
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevSep = false
			continue
		}

		// Collapse runs of spaces, tabs, underscores, and hyphens into a single hyphen.
		if r == ' ' || r == '\t' || r == '_' || r == '-' {
			if !prevSep {
				b.WriteByte('-')
				prevSep = true
			}
			continue
		}

		// Other ASCII symbols and punctuation are dropped without leaving a separator.
		// (prevSep is unchanged: a dropped symbol does not act as a separator.)
		_ = unicode.IsSpace // keep unicode import used; not strictly needed but harmless
	}

	// Trim a trailing hyphen if present.
	out := b.String()
	if strings.HasSuffix(out, "-") {
		out = out[:len(out)-1]
	}
	return out
}
