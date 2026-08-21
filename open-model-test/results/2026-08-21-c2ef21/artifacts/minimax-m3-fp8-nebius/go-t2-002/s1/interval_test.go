package interval

import (
	"reflect"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		in   []Interval
		want []Interval
	}{
		{"empty", []Interval{}, []Interval{}},
		{"nil", nil, []Interval{}},
		{"single", []Interval{{1, 2}}, []Interval{{1, 2}}},
		{"already sorted", []Interval{{1, 2}, {3, 4}}, []Interval{{1, 2}, {3, 4}}},
		{"unsorted", []Interval{{5, 6}, {1, 2}}, []Interval{{1, 2}, {5, 6}}},
		{"overlap merges", []Interval{{1, 4}, {3, 6}}, []Interval{{1, 6}}},
		{"touching merges", []Interval{{1, 3}, {3, 5}}, []Interval{{1, 5}}},
		{"containment collapses", []Interval{{1, 10}, {2, 3}, {4, 5}}, []Interval{{1, 10}}},
		{"degenerate dropped", []Interval{{2, 2}, {1, 3}, {5, 4}}, []Interval{{1, 3}}},
		{"negatives", []Interval{{-5, -3}, {-4, -1}, {0, 2}}, []Interval{{-5, -1}, {0, 2}}},
		{"all degenerate", []Interval{{7, 7}, {3, 1}}, []Interval{}},
		{"chain merge", []Interval{{1, 2}, {2, 3}, {3, 4}}, []Interval{{1, 4}}},
	}
	for _, c := range cases {
		got := Normalize(c.in)
		if len(got) == 0 && len(c.want) == 0 {
			if got == nil {
				t.Errorf("%s: Normalize returned nil, want non-nil empty", c.name)
			}
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: Normalize(%v) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

func TestNormalizeDoesNotMutate(t *testing.T) {
	in := []Interval{{5, 6}, {1, 2}}
	_ = Normalize(in)
	if !reflect.DeepEqual(in, []Interval{{5, 6}, {1, 2}}) {
		t.Errorf("Normalize mutated its input: %v", in)
	}
}

func TestTotalLength(t *testing.T) {
	cases := []struct {
		name string
		in   []Interval
		want int
	}{
		{"empty", []Interval{}, 0},
		{"single", []Interval{{1, 5}}, 4},
		{"disjoint", []Interval{{1, 3}, {5, 8}}, 2 + 3},
		{"overlapping no double count", []Interval{{1, 5}, {3, 7}}, 6},
		{"identical", []Interval{{1, 5}, {1, 5}}, 4},
		{"unsorted overlap", []Interval{{5, 8}, {1, 6}}, 7},
		{"degenerate contributes zero", []Interval{{2, 2}, {1, 5}}, 4},
		{"negatives", []Interval{{-3, -1}, {-1, 2}}, 5},
	}
	for _, c := range cases {
		if got := TotalLength(c.in); got != c.want {
			t.Errorf("%s: TotalLength(%v) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}
