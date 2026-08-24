package conf

import "strings"

// parseFile parses key=value lines. Empty lines and lines starting with
// '#' are ignored, as are lines without '='. Only the first '=' splits
// each pair; whitespace around keys and values is trimmed.
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
		value := strings.TrimSpace(line[i+1:])
		out[key] = value
	}
	return out
}
