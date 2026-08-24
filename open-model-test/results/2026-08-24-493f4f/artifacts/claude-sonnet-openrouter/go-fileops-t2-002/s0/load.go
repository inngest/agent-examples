// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries provide the base configuration; environment variables
// prefixed with "APP_" override entries with the matching key (prefix
// stripped).
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	for _, key := range parseEnviron(environ) {
		out[key.Key] = key.Value
	}

	return out
}

// envEntry represents a single parsed APP_-prefixed environment
// variable.
type envEntry struct {
	Key   string
	Value string
}

// parseEnviron extracts APP_-prefixed entries from environ, stripping
// the prefix from the key. Entries without '=' are ignored.
func parseEnviron(environ []string) []envEntry {
	var out []envEntry
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
		out = append(out, envEntry{Key: key, Value: value})
	}
	return out
}
