package slug

import "strings"

// Slugify converts arbitrary text into a URL slug according to the rules:
//   - ASCII letters are lowercased.
//   - ASCII letters and digits are kept.
//   - Non-ASCII runes are dropped entirely (no separator introduced).
//   - Runs of spaces, tabs, underscores, and hyphens collapse into a
//     single hyphen, but only actually emitted once a following valid
//     character appears (so leading/trailing separators produce nothing).
//   - Other ASCII punctuation/symbols are dropped without leaving a
//     separator.
func Slugify(s string) string {
	var b strings.Builder
	pendingSep := false

	isAlpha := func(r rune) bool {
		return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
	}
	isDigit := func(r rune) bool {
		return r >= '0' && r <= '9'
	}
	toLower := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}

	for _, r := range s {
		switch {
		case r >= 128:
			// Non-ASCII: drop entirely, no separator effect.
			continue
		case isAlpha(r) || isDigit(r):
			if pendingSep && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteRune(toLower(r))
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			pendingSep = true
		default:
			// Other ASCII punctuation/symbols: drop, no separator effect,
			// and do not clear any pending separator.
		}
	}

	return b.String()
}
