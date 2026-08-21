// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (key=value per line).
// Environment entries with the "APP_" prefix override file entries for
// the same key (after stripping the prefix).
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
		if key == "" {
			continue
		}
		out[key] = value
	}

	return out
}
