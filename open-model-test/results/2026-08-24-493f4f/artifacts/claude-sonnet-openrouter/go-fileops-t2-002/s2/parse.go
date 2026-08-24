package conf

import "strings"

// parseFile parses key=value lines. Empty lines and lines starting
// with '#' are ignored. Only the first '=' splits key from value.
func parseFile(content string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i < 0 {
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(line[i+1:])
		out[key] = val
	}
	return out
}

// parseEnviron parses environ entries (KEY=VALUE) and returns a map
// of keys with the "APP_" prefix stripped, for those that have it.
// Entries without '=' are ignored. No trimming is applied to values.
func parseEnviron(environ []string) map[string]string {
	const prefix = "APP_"
	out := map[string]string{}
	for _, entry := range environ {
		i := strings.Index(entry, "=")
		if i < 0 {
			continue
		}
		key := entry[:i]
		val := entry[i+1:]
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		out[strings.TrimPrefix(key, prefix)] = val
	}
	return out
}
