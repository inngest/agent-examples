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

		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
			prevSep = false
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevSep = false
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if !prevSep && b.Len() > 0 {
				b.WriteByte('-')
				prevSep = true
			}
		default:
			// Other ASCII symbols/punctuation: dropped without separator.
		}
	}

	// Strip a trailing hyphen if one was written.
	out := b.String()
	if strings.HasSuffix(out, "-") {
		out = out[:len(out)-1]
	}
	return out
}

// keep unicode import referenced for clarity in some toolchains
var _ = unicode.IsSpace
