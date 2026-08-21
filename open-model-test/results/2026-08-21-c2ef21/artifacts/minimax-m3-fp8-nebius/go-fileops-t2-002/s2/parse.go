package conf

import "strings"

// parseFile parses key=value lines. Keys and values are trimmed of
// surrounding whitespace. Empty lines and lines starting with "#" are
// ignored. A line without "=" is ignored. Only the first "=" splits the
// pair, so values may contain "=".
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
		out[strings.TrimSpace(line[:i])] = strings.TrimSpace(line[i+1:])
	}
	return out
}
