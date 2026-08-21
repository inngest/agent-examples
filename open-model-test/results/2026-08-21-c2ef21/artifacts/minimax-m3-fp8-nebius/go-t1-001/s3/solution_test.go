package words

import (
	"reflect"
	"testing"
)

func TestWordFrequencySimple(t *testing.T) {
	got := WordFrequency("the quick brown fox the")
	want := map[string]int{"the": 2, "quick": 1, "brown": 1, "fox": 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordFrequency = %v, want %v", got, want)
	}
}

func TestWordFrequencyCaseInsensitive(t *testing.T) {
	got := WordFrequency("Go go GO")
	want := map[string]int{"go": 3}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordFrequency = %v, want %v", got, want)
	}
}

func TestWordFrequencyPunctuationSeparates(t *testing.T) {
	got := WordFrequency("hello, world! hello?")
	want := map[string]int{"hello": 2, "world": 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordFrequency = %v, want %v", got, want)
	}
}

func TestWordFrequencyUnicode(t *testing.T) {
	got := WordFrequency("café cafe café")
	want := map[string]int{"café": 2, "cafe": 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordFrequency = %v, want %v", got, want)
	}
}

func TestWordFrequencyDigits(t *testing.T) {
	got := WordFrequency("a1 a2 a1")
	want := map[string]int{"a1": 2, "a2": 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordFrequency = %v, want %v", got, want)
	}
}

func TestWordFrequencyEmpty(t *testing.T) {
	got := WordFrequency(" !!! ... ")
	if got == nil {
		t.Fatal("WordFrequency returned nil map, want non-nil")
	}
	if len(got) != 0 {
		t.Errorf("WordFrequency = %v, want empty map", got)
	}
}
