package conf

import "strings"

// parseFile parses key=value lines from a config file. Blank lines and
// lines starting with '#' are ignored. Only the first '=' splits the
// pair, so values may contain '='. Whitespace around keys and values is
// trimmed.
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
