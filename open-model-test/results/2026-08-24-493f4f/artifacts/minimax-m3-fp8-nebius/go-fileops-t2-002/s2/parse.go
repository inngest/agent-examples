package conf

import "strings"

// parseFile parses key=value lines from a config file. It returns a map
// containing every successfully parsed entry; keys set to the empty
// string are preserved. Lines that are empty, consist only of
// whitespace, start with '#', or lack an '=' are ignored. Only the first
// '=' splits the key from the value; whitespace around the key and value
// is trimmed. Keys are lowercased so they match environment overrides.
func parseFile(content string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		i := strings.Index(trimmed, "=")
		if i < 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(trimmed[:i]))
		value := strings.TrimSpace(trimmed[i+1:])
		out[key] = value
	}
	return out
}
