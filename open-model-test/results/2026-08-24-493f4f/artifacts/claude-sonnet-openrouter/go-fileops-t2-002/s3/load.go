// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from key=value lines. Environment entries
// whose key starts with "APP_" override file entries (with the prefix
// stripped from the key).
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	for _, env := range environ {
		i := strings.Index(env, "=")
		if i < 0 {
			continue
		}
		key := env[:i]
		value := env[i+1:]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		key = strings.TrimPrefix(key, "APP_")
		out[key] = value
	}

	return out
}
