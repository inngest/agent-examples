package words

import "unicode"

// WordFrequency counts how many times each word appears in s.
// A word is a maximal run of Unicode letters or digits; everything else
// (spaces, punctuation, symbols) is a separator. Counting is case-insensitive.
func WordFrequency(s string) map[string]int {
	result := make(map[string]int)
	var current []rune

	flush := func() {
		if len(current) > 0 {
			word := string(current)
			result[word]++
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

	return result
}
