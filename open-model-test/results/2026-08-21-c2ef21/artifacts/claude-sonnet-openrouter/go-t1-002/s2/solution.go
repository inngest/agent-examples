package slug

import "strings"

// Slugify converts arbitrary text into a URL slug.
func Slugify(s string) string {
	var sb strings.Builder
	pendingSep := false

	isSep := func(r rune) bool {
		return r == ' ' || r == '\t' || r == '_' || r == '-'
	}

	for _, r := range s {
		if r >= 128 {
			// non-ASCII: drop, no effect on separator state
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			r = r - 'A' + 'a'
			if pendingSep && sb.Len() > 0 {
				sb.WriteByte('-')
			}
			pendingSep = false
			sb.WriteRune(r)
		case r >= 'a' && r <= 'z':
			if pendingSep && sb.Len() > 0 {
				sb.WriteByte('-')
			}
			pendingSep = false
			sb.WriteRune(r)
		case r >= '0' && r <= '9':
			if pendingSep && sb.Len() > 0 {
				sb.WriteByte('-')
			}
			pendingSep = false
			sb.WriteRune(r)
		case isSep(r):
			if sb.Len() > 0 {
				pendingSep = true
			}
		default:
			// other ASCII symbols/punctuation: drop without leaving a separator
			// pending flag unaffected
		}
	}

	return sb.String()
}
