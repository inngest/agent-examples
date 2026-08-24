// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from fileContent (one key=value per line;
// whitespace trimmed; blank lines and lines starting with '#' ignored;
// only the first '=' splits the pair). Environment entries are taken
// from environ (KEY=VALUE strings, like os.Environ); only entries whose
// key starts with "APP_" are considered, and that prefix is stripped.
// The resulting env key is lowercased. Environment entries override
// file entries for the same key. A key set to the empty string is
// still present in the result. The returned map is non-nil and Load
// never panics on odd input.
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
