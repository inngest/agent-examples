// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed as key=value lines, and environment entries
// prefixed with APP_ override matching keys (with the prefix stripped).
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
