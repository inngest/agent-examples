// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line; blank
// lines and lines starting with '#' are ignored; only the first '=' splits
// the pair; whitespace around keys and values is trimmed). File keys are
// normalized to lower case.
//
// Environment entries are taken from environ (KEY=VALUE strings, like
// os.Environ). Only entries whose key starts with "APP_" are considered;
// the prefix is stripped and the remaining key is normalized to lower
// case. Entries without '=' are ignored. No trimming is applied to
// environ values.
//
// Environment entries override file entries for the same key. The
// returned map is non-nil and contains nothing beyond the rules above.
// Load never panics on odd input.
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
		out[strings.ToLower(key[len("APP_"):])] = entry[i+1:]
	}

	return out
}
