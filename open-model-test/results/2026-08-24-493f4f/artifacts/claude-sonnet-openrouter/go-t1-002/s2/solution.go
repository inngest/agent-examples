package slug

import "strings"

// Slugify converts arbitrary text into a URL slug according to the rules:
//   - ASCII letters are lowercased.
//   - ASCII letters and digits are kept as-is (after lowercasing).
//   - Non-ASCII runes (>= U+0080) are dropped entirely, without producing
//     a separator.
//   - Runs of spaces, tabs, underscores, and hyphens collapse into a
//     single '-' separator between kept characters.
//   - Other ASCII punctuation/symbols are dropped without leaving a
//     separator.
//   - Leading/trailing separators produce no leading/trailing hyphen.
func Slugify(s string) string {
	var b strings.Builder
	pendingSep := false
	started := false

	for _, r := range s {
		if r >= 128 {
			// Non-ASCII: drop entirely, no effect on separators.
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			if pendingSep && started {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteByte(byte(r - 'A' + 'a'))
			started = true

		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingSep && started {
				b.WriteByte('-')
			}
			pendingSep = false
			b.WriteRune(r)
			started = true

		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if started {
				pendingSep = true
			}

		default:
			// Other ASCII punctuation/symbols: dropped, no separator.
		}
	}

	return b.String()
}
