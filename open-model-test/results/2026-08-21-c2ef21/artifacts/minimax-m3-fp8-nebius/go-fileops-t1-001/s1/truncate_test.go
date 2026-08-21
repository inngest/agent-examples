package strkit

import (
	"testing"
	"unicode/utf8"
)

func TestTruncateASCII(t *testing.T) {
	if got := Truncate("hello world", 5); got != "hello…" {
		t.Errorf("Truncate ASCII: got %q, want %q", got, "hello…")
	}
	if got := Truncate("hello", 10); got != "hello" {
		t.Errorf("no shortening: got %q, want unchanged", got)
	}
	if got := Truncate("hello", 5); got != "hello" {
		t.Errorf("exact length: got %q, want unchanged", got)
	}
}

func TestTruncateRunes(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"日本語のテキスト", 3, "日本語…"},
		{"日本語", 5, "日本語"},
		{"café au lait", 4, "café…"},
		{"🎉🎊🎈", 2, "🎉🎊…"},
		{"a🎉b", 3, "a🎉b"},
	}
	for _, c := range cases {
		if got := Truncate(c.in, c.n); got != c.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestTruncateEdges(t *testing.T) {
	if got := Truncate("anything", 0); got != "" {
		t.Errorf("n=0: got %q, want empty", got)
	}
	if got := Truncate("anything", -3); got != "" {
		t.Errorf("n<0: got %q, want empty", got)
	}
	if got := Truncate("", 5); got != "" {
		t.Errorf("empty input: got %q, want empty", got)
	}
}

func TestTruncateValidUTF8(t *testing.T) {
	for _, in := range []string{"日本語のテキスト", "mixed 🎉 text", "áéíóú"} {
		for _, n := range []int{1, 2, 3} {
			got := Truncate(in, n)
			if !utf8.ValidString(got) {
				t.Fatalf("Truncate(%q, %d) produced invalid UTF-8: %q", in, n, got)
			}
		}
	}
}
