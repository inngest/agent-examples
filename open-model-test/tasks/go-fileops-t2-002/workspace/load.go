// Package conf merges configuration from file contents and the
// environment.
package conf

// Load merges a config file's content with environment overrides.
//
// TODO: implement the full contract from the task description. The stub
// below ignores the environment entirely.
func Load(fileContent string, environ []string) map[string]string {
	return parseFile(fileContent)
}
