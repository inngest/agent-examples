// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line; lines
// starting with '#' and lines without '=' are ignored; whitespace around
// keys and values is trimmed; only the first '=' splits a pair).
//
// Environment entries are taken from environ (KEY=VALUE strings, like
// os.Environ). Only entries whose key starts with "APP_" are considered;
// the prefix is stripped. Entries without '=' are ignored. No trimming
// is applied to environ values. Environment keys match file keys
// case-insensitively, and the override preserves the file key's casing.
//
// Environment entries override file entries for the same key. A key set
// to the empty string is still present in the result. The returned map
// is non-nil and contains nothing beyond the rules above.
func Load(fileContent string, environ []string) map[string]string {
	out := map[string]string{}
	caseMap := map[string]string{}

	for k, v := range parseFile(fileContent) {
		out[k] = v
		caseMap[strings.ToLower(k)] = k
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
		stripped := key[len("APP_"):]
		if stripped == "" {
			continue
		}
		val := entry[i+1:]
		lower := strings.ToLower(stripped)
		if existing, ok := caseMap[lower]; ok {
			out[existing] = val
		} else {
			out[stripped] = val
			caseMap[lower] = stripped
		}
	}

	return out
}
