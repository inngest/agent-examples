package interval

import "sort"

// Interval represents a half-open interval [Start, End).
type Interval struct {
	Start int
	End   int
}

// Normalize sorts the intervals by Start and merges any that overlap or
// touch (gap of zero). Degenerate intervals (Start >= End) are dropped.
// The returned slice is always non-nil and does not share storage with
// the input slice.
func Normalize(xs []Interval) []Interval {
	out := make([]Interval, 0, len(xs))
	if len(xs) == 0 {
		return out
	}

	// Copy and sort by Start, then End.
	tmp := make([]Interval, len(xs))
	copy(tmp, xs)
	sort.Slice(tmp, func(i, j int) bool {
		if tmp[i].Start != tmp[j].Start {
			return tmp[i].Start < tmp[j].Start
		}
		return tmp[i].End < tmp[j].End
	})

	for _, iv := range tmp {
		if iv.Start >= iv.End {
			continue
		}
		if n := len(out); n > 0 && iv.Start <= out[n-1].End {
			if iv.End > out[n-1].End {
				out[n-1].End = iv.End
			}
			continue
		}
		out = append(out, iv)
	}
	return out
}

// TotalLength returns the number of integers covered by the union of xs.
// Overlapping intervals must not double-count. Degenerate intervals
// contribute zero. The input is not normalized first; this function
// handles unsorted and overlapping input directly.
func TotalLength(xs []Interval) int {
	if len(xs) == 0 {
		return 0
	}

	// Copy and sort by Start, then End.
	tmp := make([]Interval, len(xs))
	copy(tmp, xs)
	sort.Slice(tmp, func(i, j int) bool {
		if tmp[i].Start != tmp[j].Start {
			return tmp[i].Start < tmp[j].Start
		}
		return tmp[i].End < tmp[j].End
	})

	total := 0
	curStart, curEnd := 0, 0
	started := false
	for _, iv := range tmp {
		if iv.Start >= iv.End {
			continue
		}
		if !started {
			curStart, curEnd = iv.Start, iv.End
			started = true
			continue
		}
		if iv.Start <= curEnd {
			if iv.End > curEnd {
				curEnd = iv.End
			}
			continue
		}
		total += curEnd - curStart
		curStart, curEnd = iv.Start, iv.End
	}
	if started {
		total += curEnd - curStart
	}
	return total
}
