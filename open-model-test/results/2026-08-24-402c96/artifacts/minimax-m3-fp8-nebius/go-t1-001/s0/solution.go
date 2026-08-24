package words

import "unicode"

// WordFrequency returns a map counting the occurrences of each word in s.
// A word is a maximal run of Unicode letters or digits; all other runes
// are treated as separators. Counting is case-insensitive. An empty or
// separator-only string yields an empty (non-nil) map.
func WordFrequency(s string) map[string]int {
	freq := make(map[string]int)
	word := make([]rune, 0, len(s))
	flush := func() {
		if len(word) > 0 {
			key := string(word)
			freq[key]++
			word = word[:0]
		}
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			word = append(word, unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()
	return freq
}
