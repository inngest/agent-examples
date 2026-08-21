package conf

import (
	"reflect"
	"testing"
)

func TestFileParsing(t *testing.T) {
	file := `
# comment
HOST = example.com
port=8080
empty=
weird=key=with=equals
no equals sign here

`
	got := Load(file, nil)
	want := map[string]string{
		"HOST":  "example.com",
		"port":  "8080",
		"empty": "",
		"weird": "key=with=equals",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("file parsing:\n got %v\nwant %v", got, want)
	}
}

func TestEnvParsing(t *testing.T) {
	got := Load("", []string{
		"APP_TIMEOUT=5",
		"APP_EMPTY=",
		"OTHER_X=1",
		"BROKEN",
		"APP_A=B=C",
	})
	want := map[string]string{
		"TIMEOUT": "5",
		"EMPTY":   "",
		"A":       "B=C",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("env parsing:\n got %v\nwant %v", got, want)
	}
}

func TestPrecedence(t *testing.T) {
	got := Load(
		"timeout=1\nname=file",
		[]string{"APP_TIMEOUT=2", "IGNORED=3"},
	)
	want := map[string]string{"timeout": "2", "name": "file"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("precedence (env must win):\n got %v\nwant %v", got, want)
	}
}

func TestNoTrimFromEnv(t *testing.T) {
	got := Load("", []string{"APP_SPACES=  padded  "})
	if got["SPACES"] != "  padded  " {
		t.Errorf("environ values must not be trimmed: got %q", got["SPACES"])
	}
}

func TestEmptyInputs(t *testing.T) {
	got := Load("", nil)
	if got == nil {
		t.Fatalf("Load must return a non-nil map for empty input")
	}
	if len(got) != 0 {
		t.Errorf("empty input should yield empty map, got %v", got)
	}
}

func TestEmptyStringOverride(t *testing.T) {
	got := Load("k=filevalue", []string{"APP_K="})
	if v, ok := got["k"]; !ok || v != "" {
		t.Errorf("APP_K= must override with empty string: got %q (present=%v)", v, ok)
	}
}
