package slug

import "strings"

// Slugify converts arbitrary text into a URL slug according to the rules:
//   - ASCII letters are lowercased and kept.
//   - ASCII digits are kept.
//   - Non-ASCII runes are dropped entirely.
//   - Runs of spaces, tabs, underscores, and hyphens collapse into a
//     single '-' separator (but never at the start or end of the result).
//   - Other ASCII punctuation/symbols are dropped without producing a
//     separator.
func Slugify(s string) string {
	var b strings.Builder
	needSep := false

	isSeparatorChar := func(r rune) bool {
		return r == ' ' || r == '\t' || r == '_' || r == '-'
	}

	for _, r := range s {
		if r >= 128 {
			// Non-ASCII: drop entirely.
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			if needSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			needSep = false
			b.WriteByte(byte(r - 'A' + 'a'))
		case r >= 'a' && r <= 'z':
			if needSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			needSep = false
			b.WriteByte(byte(r))
		case r >= '0' && r <= '9':
			if needSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			needSep = false
			b.WriteByte(byte(r))
		case isSeparatorChar(r):
			if b.Len() > 0 {
				needSep = true
			}
		default:
			// Other ASCII punctuation/symbols: drop without separator.
		}
	}

	return b.String()
}
