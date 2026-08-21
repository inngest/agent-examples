// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries come from parseFile. Environment entries are taken from
// environ (in os.Environ form) and only those whose key starts with
// "APP_" are considered; the prefix is stripped. Environment entries
// override file entries for the same key. Environ values are not
// trimmed. The returned map is always non-nil.
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
		stripped := key[len("APP_"):]
		if stripped == "" {
			continue
		}
		out[stripped] = entry[i+1:]
	}
	return out
}
