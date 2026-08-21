// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File content provides key=value pairs. Environment variables prefixed
// with APP_ override file values (with the prefix stripped).
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		value := entry[i+1:]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		key = strings.TrimPrefix(key, "APP_")
		out[key] = value
	}

	return out
}
