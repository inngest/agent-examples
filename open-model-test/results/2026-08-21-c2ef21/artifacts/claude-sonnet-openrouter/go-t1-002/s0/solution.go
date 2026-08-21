package slug

import "strings"

// Slugify converts arbitrary text into a URL slug.
func Slugify(s string) string {
	var b strings.Builder
	pendingSep := false
	started := false

	isSepChar := func(r rune) bool {
		return r == ' ' || r == '\t' || r == '_' || r == '-'
	}

	for _, r := range s {
		if r >= 0x80 {
			// non-ASCII, drop entirely (no separator effect)
			continue
		}
		if isSepChar(r) {
			if started {
				pendingSep = true
			}
			continue
		}
		var c rune
		switch {
		case r >= 'A' && r <= 'Z':
			c = r - 'A' + 'a'
		case r >= 'a' && r <= 'z':
			c = r
		case r >= '0' && r <= '9':
			c = r
		default:
			// other ASCII symbols/punctuation, dropped without separator
			continue
		}

		if pendingSep && started {
			b.WriteRune('-')
		}
		pendingSep = false
		b.WriteRune(c)
		started = true
	}

	return b.String()
}
