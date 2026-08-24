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
		if r >= 0x80 {
			// non-ASCII: drop
			continue
		}
		if isSep(r) {
			pendingSep = true
			continue
		}
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			if pendingSep && sb.Len() > 0 {
				sb.WriteByte('-')
			}
			pendingSep = false
			if r >= 'A' && r <= 'Z' {
				r = r - 'A' + 'a'
			}
			sb.WriteRune(r)
			continue
		}
		// other ASCII punctuation/symbols: drop, no separator effect
	}

	return sb.String()
}
