package interval

import "sort"

// Interval represents a half-open interval [Start, End).
type Interval struct {
	Start int
	End   int
}

// Normalize sorts the intervals by Start and merges any that overlap or
// touch (gap of zero). Degenerate intervals (Start >= End) are dropped.
// The returned slice is always non-nil. The input slice is not mutated.
func Normalize(xs []Interval) []Interval {
	// Make a copy so we don't mutate the caller's slice.
	if len(xs) == 0 {
		return []Interval{}
	}
	cp := make([]Interval, len(xs))
	copy(cp, xs)

	// Drop degenerate intervals.
	filtered := cp[:0]
	for _, iv := range cp {
		if iv.Start < iv.End {
			filtered = append(filtered, iv)
		}
	}
	if len(filtered) == 0 {
		return []Interval{}
	}

	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].Start != filtered[j].Start {
			return filtered[i].Start < filtered[j].Start
		}
		return filtered[i].End < filtered[j].End
	})

	out := make([]Interval, 0, len(filtered))
	cur := filtered[0]
	for i := 1; i < len(filtered); i++ {
		iv := filtered[i]
		if iv.Start <= cur.End { // overlap or touch
			if iv.End > cur.End {
				cur.End = iv.End
			}
		} else {
			out = append(out, cur)
			cur = iv
		}
	}
	out = append(out, cur)
	return out
}

// TotalLength returns the number of integers covered by the union of xs.
// The input is NOT normalized first; overlapping intervals must not
// double-count. Degenerate intervals contribute zero.
func TotalLength(xs []Interval) int {
	if len(xs) == 0 {
		return 0
	}
	// Copy and filter degenerate intervals.
	cp := make([]Interval, 0, len(xs))
	for _, iv := range xs {
		if iv.Start < iv.End {
			cp = append(cp, iv)
		}
	}
	if len(cp) == 0 {
		return 0
	}

	sort.Slice(cp, func(i, j int) bool {
		if cp[i].Start != cp[j].Start {
			return cp[i].Start < cp[j].Start
		}
		return cp[i].End < cp[j].End
	})

	total := 0
	curStart := cp[0].Start
	curEnd := cp[0].End
	for i := 1; i < len(cp); i++ {
		iv := cp[i]
		if iv.Start <= curEnd { // overlap or touch
			if iv.End > curEnd {
				curEnd = iv.End
			}
		} else {
			total += curEnd - curStart
			curStart = iv.Start
			curEnd = iv.End
		}
	}
	total += curEnd - curStart
	return total
}
