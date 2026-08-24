// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from key=value lines (one per line). Environment
// entries are taken from environ (like os.Environ); only entries whose key
// starts with "APP_" are considered, and that prefix is stripped from the
// key. The resulting env key is lowercased so it matches the
// case-insensitive convention used by file keys. Environment entries
// override file entries for the same key. The returned map is non-nil and
// contains only keys established by these rules; keys explicitly set to
// the empty string are preserved.
func Load(fileContent string, environ []string) map[string]string {
	out := map[string]string{}

	for k, v := range parseFile(fileContent) {
		out[k] = v
	}

	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		out[strings.ToLower(key[len("APP_"):])] = entry[i+1:]
	}

	return out
}
