// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line; blank
// lines and lines starting with '#' are ignored; only the first '=' splits
// the pair; whitespace around keys and values is trimmed).
//
// Environment entries are taken from environ (in the form KEY=VALUE, as
// returned by os.Environ). Only entries whose key starts with "APP_" are
// considered; the prefix is stripped from the key. Entries without '='
// are ignored. No trimming is applied to environ values.
//
// Environment entries override file entries for the same key (compared
// case-insensitively). A key set to the empty string is still present in
// the result. The returned map is non-nil and Load never panics on odd
// input.
func Load(fileContent string, environ []string) map[string]string {
	out := map[string]string{}

	for k, v := range parseFile(fileContent) {
		out[k] = v
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

		// Check if a file entry exists with the same key (case-insensitive).
		matched := false
		for fk := range out {
			if strings.EqualFold(fk, envKey) {
				out[fk] = envVal
				matched = true
				break
			}
		}
		if !matched {
			out[envKey] = envVal
		}
	}

	return out
}
