package interval

import "sort"

// Interval represents a half-open interval [Start, End).
type Interval struct {
	Start int
	End   int
}

// Normalize sorts the intervals by Start and merges any that overlap OR
// touch (gap of zero). Degenerate intervals are dropped. The returned
// slice is always non-nil.
func Normalize(xs []Interval) []Interval {
	result := make([]Interval, 0, len(xs))

	filtered := make([]Interval, 0, len(xs))
	for _, iv := range xs {
		if iv.Start < iv.End {
			filtered = append(filtered, iv)
		}
	}

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Start < filtered[j].Start
	})

	for _, iv := range filtered {
		n := len(result)
		if n > 0 && iv.Start <= result[n-1].End {
			if iv.End > result[n-1].End {
				result[n-1].End = iv.End
			}
		} else {
			result = append(result, iv)
		}
	}

	return result
}

// TotalLength returns the number of integers covered by the union of xs.
func TotalLength(xs []Interval) int {
	normalized := Normalize(xs)
	total := 0
	for _, iv := range normalized {
		total += iv.End - iv.Start
	}
	return total
}
