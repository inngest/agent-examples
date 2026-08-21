// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// fileContent contains key=value pairs, one per line. environ contains
// entries like os.Environ; only keys prefixed with "APP_" are considered,
// and that prefix is stripped before merging. Environment entries take
// precedence over file entries for the same key.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		val := entry[i+1:]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		key = strings.TrimPrefix(key, "APP_")
		out[key] = val
	}

	return out
}
