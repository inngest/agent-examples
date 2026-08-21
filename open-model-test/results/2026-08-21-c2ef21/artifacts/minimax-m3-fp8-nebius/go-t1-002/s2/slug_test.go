package slug

import "testing"

func TestSlugify(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Hello, World!", "hello-world"},
		{"  Multiple   Spaces  ", "multiple-spaces"},
		{"café_réstaurant", "caf-rstaurant"},
		{"!!!", ""},
		{"", ""},
		{"already-a-slug", "already-a-slug"},
		{"UPPER lower", "upper-lower"},
		{"tabs\tand\ttabs", "tabs-and-tabs"},
		{"mixed_-separators  -_", "mixed-separators"},
		{"-leading and trailing-", "leading-and-trailing"},
		{"numbers 123 stay", "numbers-123-stay"},
		{"日本語 text", "text"},
		{"emoji 🎉party", "emoji-party"},
		{"a", "a"},
		{"-", ""},
		{"___", ""},
		{"Hello--World", "hello-world"},
		{"l'été est arrivé", "lt-est-arriv"},
	}
	for _, c := range cases {
		if got := Slugify(c.in); got != c.want {
			t.Errorf("Slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
