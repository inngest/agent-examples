// Package conf merges configuration from file contents and the
// environment.
package conf

// Load merges a config file's content with environment overrides.
//
// File entries are parsed from key=value lines. Environment entries
// whose key starts with "APP_" override file entries (with the prefix
// stripped from the key).
func Load(fileContent string, environ []string) map[string]string {
	out := parseFile(fileContent)

	for k, v := range parseEnviron(environ) {
		out[k] = v
	}

	return out
}
