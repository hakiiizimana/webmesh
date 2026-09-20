package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	md "github.com/firecrawl/html-to-markdown"
	"github.com/firecrawl/html-to-markdown/plugin"
)

// Bound stdin so a producer cannot exhaust memory.
const maxInputBytes = 8 << 20

const version = "webmesh-html-to-markdown/1"

func convert(html string) (string, error) {
	converter := md.NewConverter("", true, nil)
	converter.Use(plugin.GitHubFlavored())
	converter.Use(plugin.RobustCodeBlock())
	return converter.ConvertString(html)
}

func run(stdin io.Reader, stdout io.Writer, args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "--version", "-version", "version":
			_, err := fmt.Fprintln(stdout, version)
			return err
		}
	}
	limited := io.LimitReader(stdin, maxInputBytes+1)
	input, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	if len(input) > maxInputBytes {
		return fmt.Errorf("input exceeds %d bytes", maxInputBytes)
	}
	markdown, err := convert(string(input))
	if err != nil {
		return fmt.Errorf("convert: %w", err)
	}
	_, err = io.WriteString(stdout, markdown)
	return err
}

func main() {
	if err := run(os.Stdin, os.Stdout, os.Args[1:]); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			fmt.Fprintln(os.Stderr, "html-to-markdown:", err)
		}
		os.Exit(1)
	}
}
