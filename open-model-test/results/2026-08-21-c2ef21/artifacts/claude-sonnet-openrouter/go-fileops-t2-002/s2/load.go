// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File contents are parsed as key=value lines. Environment entries
// prefixed with APP_ override values for the corresponding key (with
// the prefix stripped). The match against existing file-derived keys
// is case-insensitive: if a key already exists (from the file) that
// matches the stripped environment key ignoring case, that existing
// key's value is overridden (its original casing is preserved).
// Otherwise, a new entry is added using the stripped environment key
// as-is.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	// Index existing keys by lower-case form so environment overrides
	// can be matched case-insensitively.
	lowerIndex := make(map[string]string, len(out))
	for k := range out {
		lowerIndex[strings.ToLower(k)] = k
	}

	for _, e := range environ {
		i := strings.Index(e, "=")
		if i < 0 {
			continue
		}
		key := e[:i]
		val := e[i+1:]
		if !strings.HasPrefix(key, "APP_") {
			continue
		}
		key = strings.TrimPrefix(key, "APP_")

		lowerKey := strings.ToLower(key)
		if orig, ok := lowerIndex[lowerKey]; ok {
			out[orig] = val
		} else {
			out[key] = val
			lowerIndex[lowerKey] = key
		}
	}

	return out
}
