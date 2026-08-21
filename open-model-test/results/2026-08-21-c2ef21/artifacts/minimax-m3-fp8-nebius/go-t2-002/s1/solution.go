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
	out := make([]Interval, 0)
	if len(xs) == 0 {
		return out
	}

	// Copy to avoid mutating the input.
	cp := make([]Interval, len(xs))
	copy(cp, xs)

	sort.Slice(cp, func(i, j int) bool {
		if cp[i].Start != cp[j].Start {
			return cp[i].Start < cp[j].Start
		}
		return cp[i].End < cp[j].End
	})

	for _, iv := range cp {
		if iv.Start >= iv.End {
			continue
		}
		if n := len(out); n > 0 && iv.Start <= out[n-1].End {
			// Overlap or touch: extend the last interval if needed.
			if iv.End > out[n-1].End {
				out[n-1].End = iv.End
			}
		} else {
			out = append(out, iv)
		}
	}
	return out
}

// TotalLength returns the number of integers covered by the union of xs.
// Overlapping intervals must not double-count. Degenerate intervals
// contribute zero. The input is not normalized first.
func TotalLength(xs []Interval) int {
	if len(xs) == 0 {
		return 0
	}

	// Copy and sort by Start, then End.
	cp := make([]Interval, len(xs))
	copy(cp, xs)

	sort.Slice(cp, func(i, j int) bool {
		if cp[i].Start != cp[j].Start {
			return cp[i].Start < cp[j].Start
		}
		return cp[i].End < cp[j].End
	})

	total := 0
	curStart, curEnd := 0, 0
	inProgress := false

	for _, iv := range cp {
		if iv.Start >= iv.End {
			continue
		}
		if !inProgress {
			curStart, curEnd = iv.Start, iv.End
			inProgress = true
			continue
		}
		if iv.Start < curEnd {
			// Overlap or touch: extend if needed.
			if iv.End > curEnd {
				curEnd = iv.End
			}
		} else {
			// Disjoint: commit current and start a new one.
			total += curEnd - curStart
			curStart, curEnd = iv.Start, iv.End
		}
	}
	if inProgress {
		total += curEnd - curStart
	}
	return total
}
