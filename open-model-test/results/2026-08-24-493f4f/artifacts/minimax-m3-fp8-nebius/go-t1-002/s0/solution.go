package slug

import "unicode"

func Slugify(s string) string {
	var b []byte
	prevSep := false
	for _, r := range s {
		if r >= 0x80 {
			continue
		}
		if unicode.IsSpace(r) || r == '_' || r == '-' {
			if !prevSep && len(b) > 0 {
				b = append(b, '-')
				prevSep = true
			}
			continue
		}
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			if r >= 'A' && r <= 'Z' {
				r = r + ('a' - 'A')
			}
			b = append(b, byte(r))
			prevSep = false
			continue
		}
	}
	if prevSep && len(b) > 0 {
		b = b[:len(b)-1]
	}
	return string(b)
}
