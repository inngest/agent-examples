package words

import "unicode"

// WordFrequency returns a map counting how many times each word appears in s.
// A word is a maximal run of Unicode letters or digits; everything else is a separator.
// Counting is case-insensitive: "Go go GO" yields {"go": 3}.
// An empty or separator-only string yields an empty (non-nil) map.
func WordFrequency(s string) map[string]int {
	result := make(map[string]int)
	var current []rune
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			current = append(current, unicode.ToLower(r))
		} else if len(current) > 0 {
			result[string(current)]++
			current = current[:0]
		}
	}
	if len(current) > 0 {
		result[string(current)]++
	}
	return result
}
