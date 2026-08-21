package words

import (
	"strings"
	"unicode"
)

func WordFrequency(s string) map[string]int {
	result := make(map[string]int)

	var sb strings.Builder
	runes := []rune(s)
	n := len(runes)

	flush := func() {
		if sb.Len() > 0 {
			word := strings.ToLower(sb.String())
			result[word]++
			sb.Reset()
		}
	}

	for i := 0; i < n; i++ {
		r := runes[i]
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			sb.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()

	return result
}
