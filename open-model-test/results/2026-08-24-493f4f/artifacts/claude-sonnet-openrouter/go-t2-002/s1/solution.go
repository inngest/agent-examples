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
	for _, x := range xs {
		if x.Start < x.End {
			filtered = append(filtered, x)
		}
	}

	if len(filtered) == 0 {
		return result
	}

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Start < filtered[j].Start
	})

	current := filtered[0]
	for _, x := range filtered[1:] {
		if x.Start <= current.End {
			if x.End > current.End {
				current.End = x.End
			}
		} else {
			result = append(result, current)
			current = x
		}
	}
	result = append(result, current)

	return result
}

// TotalLength returns the number of integers covered by the union of xs.
// The input is NOT normalized first — overlapping intervals must not
// double-count. Degenerate intervals contribute zero.
func TotalLength(xs []Interval) int {
	normalized := Normalize(xs)
	total := 0
	for _, x := range normalized {
		total += x.End - x.Start
	}
	return total
}
