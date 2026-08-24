package words

import "unicode"

// WordFrequency counts the frequency of each word in s.
// A word is a maximal run of Unicode letters or digits; everything else
// is a separator. Counting is case-insensitive.
func WordFrequency(s string) map[string]int {
	freq := make(map[string]int)
	start := -1
	for i, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if start == -1 {
				start = i
			}
		} else if start != -1 {
			word := s[start:i]
			freq[lower(word)]++
			start = -1
		}
	}
	if start != -1 {
		freq[lower(s[start:])]++
	}
	return freq
}

// lower returns s with all Unicode letters mapped to their lower case.
func lower(s string) string {
	runes := []rune(s)
	for i, r := range runes {
		runes[i] = unicode.ToLower(r)
	}
	return string(runes)
}
