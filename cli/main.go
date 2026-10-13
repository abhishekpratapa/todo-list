// The todos command: the Todos app's list, from the terminal.
package main

import (
	_ "embed"
	"os"
	"strings"

	"todos/internal/cli"
)

//go:embed VERSION
var version string

func main() {
	os.Exit(cli.Main(strings.TrimSpace(version)))
}
