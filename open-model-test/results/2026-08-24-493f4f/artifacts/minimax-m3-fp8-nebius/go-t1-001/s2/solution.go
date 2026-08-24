package words

import "unicode"

// WordFrequency counts how many times each word appears in s.
// A word is a maximal run of Unicode letters or digits; everything else
// is a separator. Counting is case-insensitive. An empty or
// separator-only string yields an empty (non-nil) map.
func WordFrequency(s string) map[string]int {
	freq := make(map[string]int)
	if s == "" {
		return freq
	}

	runes := []rune(s)
	n := len(runes)
	i := 0
	for i < n {
		// Skip separators.
		for i < n && !isWordRune(runes[i]) {
			i++
		}
		if i >= n {
			break
		}
		// Collect the word.
		start := i
		for i < n && isWordRune(runes[i]) {
			i++
		}
		word := string(runes[start:i])
		word = toLower(word)
		freq[word]++
	}
	return freq
}

// isWordRune reports whether r is a Unicode letter or digit.
func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// toLower returns the lowercase form of s using Unicode-aware mapping.
func toLower(s string) string {
	runes := []rune(s)
	for i, r := range runes {
		runes[i] = unicode.ToLower(r)
	}
	return string(runes)
}
