// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from key=value lines (one per line). Keys are
// case-sensitive and whitespace around keys and values is trimmed.
// Empty lines and lines starting with '#' are ignored. A line without
// '=' is ignored. Only the first '=' splits the pair, so values may
// contain '='.
//
// Environment entries are taken from environ (in the form of os.Environ).
// Only entries whose key starts with "APP_" are considered; that prefix
// is stripped from the key. Entries without '=' are ignored. No
// trimming is applied to environ values.
//
// Precedence: environment entries override file entries for the same
// key (compared case-insensitively, preserving the file key's casing).
// Otherwise the file value is used. A key set to the empty string
// (from either source) is still a set key with value "" and must appear
// in the result.
//
// The returned map is non-nil (an empty map for empty input) and
// contains nothing beyond the rules above. Load never panics on odd
// input.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)
	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		envKey := key[len("APP_"):]
		envVal := entry[i+1:]
		overridden := false
		for k := range out {
			if strings.EqualFold(k, envKey) {
				out[k] = envVal
				overridden = true
				break
			}
		}
		if !overridden {
			out[envKey] = envVal
		}
	}
	return out
}
