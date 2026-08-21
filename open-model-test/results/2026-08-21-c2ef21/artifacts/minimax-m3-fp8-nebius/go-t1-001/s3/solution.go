package words

import (
	"unicode"
)

// WordFrequency returns a map counting the occurrences of each word in s.
// A word is a maximal run of Unicode letters or digits; all other runes
// are treated as separators. Counting is case-insensitive. An empty or
// separator-only string yields an empty (non-nil) map.
func WordFrequency(s string) map[string]int {
	freq := make(map[string]int)
	var current []rune

	flush := func() {
		if len(current) > 0 {
			word := string(current)
			freq[word]++
			current = current[:0]
		}
	}

	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			current = append(current, unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()

	return freq
}
