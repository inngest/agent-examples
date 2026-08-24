package interval

import "sort"

type Interval struct {
	Start int
	End   int
}

// Normalize sorts the intervals by Start and merges any that overlap OR
// touch (gap of zero). Degenerate intervals are dropped. The returned
// slice is always non-nil.
func Normalize(xs []Interval) []Interval {
	result := make([]Interval, 0, len(xs))

	for _, iv := range xs {
		if iv.Start < iv.End {
			result = append(result, iv)
		}
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Start < result[j].Start
	})

	merged := make([]Interval, 0, len(result))
	for _, iv := range result {
		if len(merged) > 0 && iv.Start <= merged[len(merged)-1].End {
			if iv.End > merged[len(merged)-1].End {
				merged[len(merged)-1].End = iv.End
			}
		} else {
			merged = append(merged, iv)
		}
	}

	return merged
}

// TotalLength returns the number of integers covered by the union of xs.
// The input is NOT normalized first — overlapping intervals must not
// double-count. Degenerate intervals contribute zero.
func TotalLength(xs []Interval) int {
	normalized := Normalize(xs)
	total := 0
	for _, iv := range normalized {
		total += iv.End - iv.Start
	}
	return total
}
