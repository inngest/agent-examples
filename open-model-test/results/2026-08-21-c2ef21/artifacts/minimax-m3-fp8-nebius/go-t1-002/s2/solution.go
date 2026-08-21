package slug

import "unicode"

// Slugify converts arbitrary text into a URL slug following the rules:
//   - ASCII letters are lowercased.
//   - ASCII letters and digits are kept.
//   - Non-ASCII runes (>= U+0080) are dropped.
//   - Runs of spaces, tabs, underscores, and hyphens collapse into a single '-'.
//   - Other ASCII symbols/punctuation are dropped without leaving a separator.
//   - Leading and trailing separators are trimmed.
//   - Empty input (or input that collapses to nothing) returns "".
func Slugify(s string) string {
	var b []byte
	prevSep := false

	for _, r := range s {
		if r >= 0x80 {
			// Drop non-ASCII runes entirely.
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			b = append(b, byte(r+'a'-'A'))
			prevSep = false
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b = append(b, byte(r))
			prevSep = false
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if !prevSep && len(b) > 0 {
				b = append(b, '-')
				prevSep = true
			}
		default:
			// Other ASCII symbols/punctuation: drop without adding a separator.
			// prevSep is unchanged so adjacent separators can still collapse.
			_ = unicode.IsSpace(r) // keep import used
		}
	}

	// Trim a trailing separator if present.
	if len(b) > 0 && b[len(b)-1] == '-' {
		b = b[:len(b)-1]
	}

	return string(b)
}
