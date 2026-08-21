package expr

import (
	"math"
	"testing"
)

func TestEvalNumbers(t *testing.T) {
	ok := []struct {
		in   string
		want float64
	}{
		{"2", 2},
		{"3.14", 3.14},
		{"1+2", 3},
		{"1+2*3", 7},
		{"(1+2)*3", 9},
		{"10/4", 2.5},
		{"2^10", 1024},
		{"2^3^2", 512},
		{"-2^2", -4},
		{"(-2)^2", 4},
		{"-3*4", -12},
		{"--4", 4},
		{" 1 + 2 ", 3},
		{"((((5))))", 5},
		{"100-2-3", 95},
		{"100/10/2", 5},
	}
	for _, c := range ok {
		got, err := Eval(c.in, nil)
		if err != nil {
			t.Errorf("Eval(%q) unexpected error: %v", c.in, err)
			continue
		}
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("Eval(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestEvalVars(t *testing.T) {
	vars := map[string]float64{"x": 3, "y": 4, "x2": 10}
	ok := []struct {
		in   string
		want float64
	}{
		{"x", 3},
		{"x+y", 7},
		{"x*y", 12},
		{"x2*2", 20},
		{"x^2+y", 13},
		{"-x", -3},
	}
	for _, c := range ok {
		got, err := Eval(c.in, vars)
		if err != nil {
			t.Errorf("Eval(%q) unexpected error: %v", c.in, err)
			continue
		}
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("Eval(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	if _, err := Eval("z", vars); err == nil {
		t.Errorf(`Eval("z") with missing var: want error, got nil`)
	}
}

func TestEvalErrors(t *testing.T) {
	bad := []string{
		"",
		"2 +",
		"+2",
		"2 3",
		"(1+2",
		"1+2)",
		"1..2",
		".5",
		"2 * / 3",
		"1 + a b",
		"foo(",
	}
	for _, s := range bad {
		if _, err := Eval(s, nil); err == nil {
			t.Errorf("Eval(%q): want error, got nil", s)
		}
	}
}

func TestDivByZero(t *testing.T) {
	if _, err := Eval("1/0", nil); err == nil {
		t.Errorf(`Eval("1/0"): want error, got +Inf`)
	}
	if _, err := Eval("1/(2-2)", nil); err == nil {
		t.Errorf(`Eval("1/(2-2)"): want error, got +Inf`)
	}
}

func TestNilAndEmptyVarsEquivalent(t *testing.T) {
	a, errA := Eval("1+1", nil)
	b, errB := Eval("1+1", map[string]float64{})
	if errA != nil || errB != nil || a != b {
		t.Errorf("nil vs empty vars differ: %v/%v vs %v/%v", a, errA, b, errB)
	}
}
