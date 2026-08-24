package slug

import "unicode"

// Slugify converts arbitrary text into a URL slug following the specified rules.
func Slugify(s string) string {
	var b []byte
	prevSep := false

	for _, r := range s {
		if r >= 0x80 {
			// Drop non-ASCII runes entirely.
			continue
		}

		switch {
		case r >= 'a' && r <= 'z':
			b = append(b, byte(r))
			prevSep = false
		case r >= 'A' && r <= 'Z':
			b = append(b, byte(r)+('a'-'A'))
			prevSep = false
		case r >= '0' && r <= '9':
			b = append(b, byte(r))
			prevSep = false
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if !prevSep && len(b) > 0 {
				b = append(b, '-')
				prevSep = true
			}
		default:
			// Other ASCII symbols/punctuation: drop without leaving a separator.
			// Do not change prevSep state.
		}
	}

	// Strip trailing separator if present.
	if len(b) > 0 && b[len(b)-1] == '-' {
		b = b[:len(b)-1]
	}

	return string(b)
}
