package words

import (
	"unicode"
)

// WordFrequency returns a map counting the occurrences of each word in s.
// A word is a maximal run of Unicode letters or digits; everything else
// is a separator. Counting is case-insensitive. An empty or separator-only
// string yields an empty (non-nil) map.
func WordFrequency(s string) map[string]int {
	freq := make(map[string]int)
	word := make([]rune, 0, len(s))

	flush := func() {
		if len(word) > 0 {
			freq[string(word)]++
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
