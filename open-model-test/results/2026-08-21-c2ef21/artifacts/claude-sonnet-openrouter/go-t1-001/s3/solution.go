package words

import (
	"strings"
	"unicode"
)

func WordFrequency(s string) map[string]int {
	result := make(map[string]int)

	var sb strings.Builder
	flush := func() {
		if sb.Len() > 0 {
			word := strings.ToLower(sb.String())
			result[word]++
			sb.Reset()
		}
	}

	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			sb.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()

	return result
}
