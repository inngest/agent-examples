// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line; blank
// lines and lines starting with '#' are ignored; only the first '=' splits
// the pair; whitespace around keys and values is trimmed). Environment
// entries are taken from environ (in os.Environ form) and only entries
// whose key starts with "APP_" are considered; that prefix is stripped
// from the key. Environment entries override file entries for the same
// key (compared case-insensitively); the resulting key uses the
// environment entry's casing. The returned map is non-nil and contains
// only keys set by either source.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)
	lowerIndex := make(map[string]string, len(out))
	for k := range out {
		lowerIndex[strings.ToLower(k)] = k
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
		envKey := key[len("APP_"):]
		envVal := entry[i+1:]
		lower := strings.ToLower(envKey)
		if existing, ok := lowerIndex[lower]; ok {
			delete(out, existing)
		}
		out[envKey] = envVal
		lowerIndex[lower] = envKey
	}
	return out
}
