// Package conf merges configuration from file contents and the
// environment.
package conf

import "strings"

// Load merges a config file's content with environment overrides.
//
// fileContent is parsed as one key=value pair per line. Keys are
// case-sensitive. Whitespace around keys and values is trimmed. Empty
// lines and lines starting with "#" are ignored. A line without "=" is
// ignored. Only the first "=" splits the pair.
//
// environ is a list of KEY=VALUE strings (like os.Environ). Entries
// whose key starts with "APP_" are considered; that prefix is stripped
// and the remaining key is lowercased. Entries without "=" are ignored.
// No trimming is applied to environ values.
//
// Environment entries override file entries for the same key. A key set
// to the empty string is still a set key with value "". The returned
// map is non-nil and contains nothing beyond the rules above. Load
// never panics on odd input.
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)
	const prefix = "APP_"
	for _, entry := range environ {
		eq := strings.Index(entry, "=")
		if eq < 0 {
			continue
		}
		rawKey := entry[:eq]
		if !strings.HasPrefix(rawKey, prefix) {
			continue
		}
		key := strings.ToLower(rawKey[len(prefix):])
		out[key] = entry[eq+1:]
	}
	return out
}
