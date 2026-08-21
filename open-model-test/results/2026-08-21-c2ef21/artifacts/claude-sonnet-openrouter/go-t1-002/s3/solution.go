package slug

import "strings"

// Slugify converts arbitrary text into a URL slug.
func Slugify(s string) string {
	var b strings.Builder
	pendingSep := false
	started := false

	flushSep := func() {
		if started && pendingSep {
			b.WriteByte('-')
		}
		pendingSep = false
	}

	for _, r := range s {
		if r >= 0x80 {
			// non-ASCII rune, dropped entirely, no separator effect
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			flushSep()
			b.WriteRune(r - 'A' + 'a')
			started = true
		case r >= 'a' && r <= 'z':
			flushSep()
			b.WriteRune(r)
			started = true
		case r >= '0' && r <= '9':
			flushSep()
			b.WriteRune(r)
			started = true
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			pendingSep = true
		default:
			// other ASCII symbols/punctuation dropped, no separator
		}
	}

	return b.String()
}
