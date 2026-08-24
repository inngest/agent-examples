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
	cp := make([]Interval, len(xs))
	copy(cp, xs)

	// Drop degenerate intervals.
	filtered := cp[:0]
	for _, iv := range cp {
		if iv.Start < iv.End {
			filtered = append(filtered, iv)
		}
	}
	cp = filtered

	// Sort by Start, then End.
	sort.SliceStable(cp, func(i, j int) bool {
		if cp[i].Start != cp[j].Start {
			return cp[i].Start < cp[j].Start
		}
		return cp[i].End < cp[j].End
	})

	// Merge overlapping or touching intervals.
	out := make([]Interval, 0, len(cp))
	for _, iv := range cp {
		if len(out) == 0 {
			out = append(out, iv)
			continue
		}
		last := &out[len(out)-1]
		// Overlap or touch: iv.Start <= last.End (touching means iv.Start == last.End).
		if iv.Start <= last.End {
			if iv.End > last.End {
				last.End = iv.End
			}
		} else {
			out = append(out, iv)
		}
	}
	return out
}

// TotalLength returns the number of integers covered by the union of xs.
// The input is NOT normalized first; overlapping intervals must not
// double-count. Degenerate intervals contribute zero.
func TotalLength(xs []Interval) int {
	// Filter degenerate intervals.
	cp := make([]Interval, 0, len(xs))
	for _, iv := range xs {
		if iv.Start < iv.End {
			cp = append(cp, iv)
		}
	}
	if len(cp) == 0 {
		return 0
	}

	// Sort by Start, then End.
	sort.SliceStable(cp, func(i, j int) bool {
		if cp[i].Start != cp[j].Start {
			return cp[i].Start < cp[j].Start
		}
		return cp[i].End < cp[j].End
	})

	// Sweep and accumulate union length.
	total := 0
	curStart := cp[0].Start
	curEnd := cp[0].End
	for i := 1; i < len(cp); i++ {
		iv := cp[i]
		if iv.Start <= curEnd {
			// Overlap or touch: extend current run.
			if iv.End > curEnd {
				curEnd = iv.End
			}
		} else {
			// Disjoint: close current run and start a new one.
			total += curEnd - curStart
			curStart = iv.Start
			curEnd = iv.End
		}
	}
	total += curEnd - curStart
	return total
}
