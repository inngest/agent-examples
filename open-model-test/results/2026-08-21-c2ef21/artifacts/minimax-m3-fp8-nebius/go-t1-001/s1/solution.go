package words

import (
	"unicode"
)

// WordFrequency returns a map counting the occurrences of each word in s.
// A word is a maximal run of Unicode letters or digits; all other runes
// are treated as separators. Counting is case-insensitive.
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

// toLower lowercases the entire string using Unicode-aware mapping.
func toLower(s string) string {
	return strings.ToLower(s)
}
