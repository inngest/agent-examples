// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// fileContent contains key=value pairs, one per line. environ entries
// with keys prefixed by APP_ override values from the file (after
// stripping the prefix).
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	const prefix = "APP_"
	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		val := entry[i+1:]
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		key = strings.TrimPrefix(key, prefix)
		out[key] = val
	}

	return out
}
