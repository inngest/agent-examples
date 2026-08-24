package slug

func Slugify(s string) string {
	var result []byte
	pendingSep := false
	started := false

	for _, r := range s {
		if r >= 128 {
			// non-ASCII, drop entirely (no separator)
			continue
		}

		switch {
		case r >= 'A' && r <= 'Z':
			if pendingSep && started {
				result = append(result, '-')
			}
			pendingSep = false
			result = append(result, byte(r-'A'+'a'))
			started = true
		case r >= 'a' && r <= 'z':
			if pendingSep && started {
				result = append(result, '-')
			}
			pendingSep = false
			result = append(result, byte(r))
			started = true
		case r >= '0' && r <= '9':
			if pendingSep && started {
				result = append(result, '-')
			}
			pendingSep = false
			result = append(result, byte(r))
			started = true
		case r == ' ' || r == '\t' || r == '_' || r == '-':
			if started {
				pendingSep = true
			}
		default:
			// other ASCII symbols/punctuation: drop, no separator
		}
	}

	return string(result)
}
