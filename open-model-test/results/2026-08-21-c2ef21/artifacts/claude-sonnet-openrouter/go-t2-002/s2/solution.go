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

	// Filter out degenerate intervals and copy the rest.
	for _, iv := range xs {
		if iv.Start < iv.End {
			result = append(result, iv)
		}
	}

	if len(result) == 0 {
		return result
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].Start != result[j].Start {
			return result[i].Start < result[j].Start
		}
		return result[i].End < result[j].End
	})

	merged := make([]Interval, 0, len(result))
	current := result[0]

	for _, iv := range result[1:] {
		if iv.Start <= current.End {
			if iv.End > current.End {
				current.End = iv.End
			}
		} else {
			merged = append(merged, current)
			current = iv
		}
	}
	merged = append(merged, current)

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
