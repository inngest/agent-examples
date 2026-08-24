package slug

import "strings"

// Slugify converts arbitrary text into a URL slug according to the rules:
// - ASCII letters are lowercased.
// - ASCII letters and digits are kept.
// - Runs of spaces, tabs, underscores, and hyphens collapse into a single '-'.
// - Other ASCII punctuation/symbols are dropped without leaving a separator.
// - Non-ASCII runes (>= U+0080) are dropped entirely.
// - Leading/trailing separators produce no leading/trailing hyphen.
func Slugify(s string) string {
	var b strings.Builder
	pendingSep := false
	started := false

	isSepChar := func(r rune) bool {
		return r == ' ' || r == '\t' || r == '_' || r == '-'
	}

	for _, r := range s {
		if r >= 128 {
			// drop non-ASCII rune entirely
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			if pendingSep && started {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteRune(r - 'A' + 'a')
			started = true
		case r >= 'a' && r <= 'z':
			if pendingSep && started {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteRune(r)
			started = true
		case r >= '0' && r <= '9':
			if pendingSep && started {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteRune(r)
			started = true
		case isSepChar(r):
			pendingSep = true
		default:
			// other ASCII punctuation/symbols: dropped without separator
		}
	}

	return b.String()
}
