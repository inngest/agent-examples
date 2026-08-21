package words

import "unicode"

// WordFrequency returns a map counting the occurrences of each word in s.
// A word is a maximal run of Unicode letters or digits; everything else
// is treated as a separator. Counting is case-insensitive.
func WordFrequency(s string) map[string]int {
	result := make(map[string]int)
	var current []rune

	flush := func() {
		if len(current) > 0 {
			word := string(current)
			result[word]++
			current = nil
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
