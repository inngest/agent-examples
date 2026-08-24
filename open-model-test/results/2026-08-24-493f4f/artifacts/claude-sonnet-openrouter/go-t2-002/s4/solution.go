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

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Start < filtered[j].Start
	})

	for _, x := range filtered {
		if len(result) > 0 && x.Start <= result[len(result)-1].End {
			if x.End > result[len(result)-1].End {
				result[len(result)-1].End = x.End
			}
		} else {
			result = append(result, x)
		}
	}

	return result
}

// TotalLength returns the number of integers covered by the union of xs.
func TotalLength(xs []Interval) int {
	norm := Normalize(xs)
	total := 0
	for _, x := range norm {
		total += x.End - x.Start
	}
	return total
}
