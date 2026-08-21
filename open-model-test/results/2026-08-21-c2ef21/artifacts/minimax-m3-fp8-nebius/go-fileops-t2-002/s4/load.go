// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line).
// Environment entries are taken from environ (in os.Environ format);
// only entries whose key starts with "APP_" are considered, that
// prefix is stripped, and the remaining key is used as-is (case is
// preserved).
//
// Environment entries override file entries for the same key. When
// matching an environment key against an existing file key, the
// comparison is case-insensitive: if a file key exists whose name
// matches the environment key ignoring case, that file key is
// overwritten (preserving its original case). Otherwise the
// environment key is inserted with its own case.
//
// The returned map is always non-nil.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)
	if out == nil {
		out = map[string]string{}
	}
	const prefix = "APP_"
	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		envKey := key[len(prefix):]
		value := entry[i+1:]

		// Find a case-insensitive match among existing keys so the
		// file key's original case is preserved on override.
		match := findKeyCI(out, envKey)
		if match != "" {
			out[match] = value
		} else {
			out[envKey] = value
		}
	}
	return out
}

// findKeyCI returns the key in m that equals want ignoring ASCII case,
// or "" if no such key exists.
func findKeyCI(m map[string]string, want string) string {
	for k := range m {
		if strings.EqualFold(k, want) {
			return k
		}
	}
	return ""
}
