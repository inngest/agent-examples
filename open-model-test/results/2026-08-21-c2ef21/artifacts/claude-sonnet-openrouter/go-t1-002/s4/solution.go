package slug

func Slugify(s string) string {
	var result []byte
	pendingSep := false
	started := false

	isSep := func(r rune) bool {
		return r == ' ' || r == '\t' || r == '_' || r == '-'
	}

	for _, r := range s {
		if r >= 128 {
			// drop non-ASCII entirely
			continue
		}
		if r >= 'A' && r <= 'Z' {
			r = r - 'A' + 'a'
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if pendingSep && started {
				result = append(result, '-')
			}
			pendingSep = false
			result = append(result, byte(r))
			started = true
		} else if isSep(r) {
			if started {
				pendingSep = true
			}
		} else {
			// other ASCII symbols/punctuation: drop without separator
		}
	}

	return string(result)
}
