package loader

import (
	"errors"
	"testing"
)

func TestSuccessCached(t *testing.T) {
	calls := 0
	l := New(func(key string) (string, error) {
		calls++
		return "v:" + key, nil
	})
	for i := 0; i < 3; i++ {
		v, err := l.Get("a")
		if err != nil || v != "v:a" {
			t.Fatalf("Get #%d = (%q, %v), want (%q, nil)", i+1, v, err, "v:a")
		}
	}
	if calls != 1 {
		t.Errorf("source called %d times for a successful key, want 1", calls)
	}
}

func TestErrorsNotCached(t *testing.T) {
	boom := errors.New("boom")
	calls := 0
	l := New(func(key string) (string, error) {
		calls++
		if calls < 3 {
			return "", boom
		}
		return "recovered", nil
	})
	if _, err := l.Get("k"); !errors.Is(err, boom) {
		t.Fatalf("first Get: want boom, got %v", err)
	}
	if _, err := l.Get("k"); !errors.Is(err, boom) {
		t.Fatalf("second Get: want boom, got %v", err)
	}
	if v, err := l.Get("k"); err != nil || v != "recovered" {
		t.Fatalf("third Get = (%q, %v), want recovered value", v, err)
	}
	if calls != 3 {
		t.Errorf("source called %d times, want 3 (fail, fail, success)", calls)
	}
	// The success is now cached:
	if _, err := l.Get("k"); err != nil || calls != 3 {
		t.Errorf("post-success Get re-called source (calls=%d, err=%v)", calls, err)
	}
}

func TestKeysIsolated(t *testing.T) {
	seen := map[string]int{}
	l := New(func(key string) (string, error) {
		seen[key]++
		return key, nil
	})
	l.Get("x")
	l.Get("y")
	l.Get("x")
	if seen["x"] != 1 || seen["y"] != 1 {
		t.Errorf("per-key isolation broken: %v", seen)
	}
}

func TestNilSource(t *testing.T) {
	l := New(nil)
	if _, err := l.Get("anything"); err == nil {
		t.Fatalf("Get with nil source: want error, got nil")
	}
}

func TestDistinctLoaders(t *testing.T) {
	a := New(func(string) (string, error) { return "a", nil })
	b := New(func(string) (string, error) { return "b", nil })
	if v, _ := a.Get("k"); v != "a" {
		t.Errorf("loader a: got %q", v)
	}
	if v, _ := b.Get("k"); v != "b" {
		t.Errorf("loader b: got %q (state leaked between loaders?)", v)
	}
}
