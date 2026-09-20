package main

import (
	"bytes"
	"strings"
	"testing"
)

func mustConvert(t *testing.T, html string) string {
	t.Helper()
	markdown, err := convert(html)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	return markdown
}

func TestConvertTable(t *testing.T) {
	markdown := mustConvert(t, `<table>
<thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>wal</td><td>on</td></tr></tbody>
</table>`)
	for _, want := range []string{"| Name | Value |", "| --- | --- |", "| wal | on |"} {
		if !strings.Contains(markdown, want) {
			t.Fatalf("table output missing %q:\n%s", want, markdown)
		}
	}
}

func TestConvertNestedLists(t *testing.T) {
	markdown := mustConvert(t, `<ul>
<li>one<ul><li>one.a</li><li>one.b</li></ul></li>
<li>two<ol><li>two.a</li></ol></li>
</ul>`)
	for _, want := range []string{"- one", "  - one.a", "  - one.b", "- two", "  1. two.a"} {
		if !strings.Contains(markdown, want) {
			t.Fatalf("nested list output missing %q:\n%s", want, markdown)
		}
	}
}

func TestConvertCodeFence(t *testing.T) {
	markdown := mustConvert(t, `<pre><code class="language-go">fmt.Println("hi")</code></pre>`)
	if !strings.Contains(markdown, "```go") {
		t.Fatalf("expected a language-tagged fence:\n%s", markdown)
	}
	if !strings.Contains(markdown, `fmt.Println("hi")`) {
		t.Fatalf("expected the code body:\n%s", markdown)
	}
}

func TestConvertRobustCodeBlockSkipsGutters(t *testing.T) {
	markdown := mustConvert(t, `<pre><code><table><tbody><tr><td class="gutter">1</td><td class="code">x := 1</td></tr></tbody></table></code></pre>`)
	if !strings.Contains(markdown, "x := 1") {
		t.Fatalf("expected the code body:\n%s", markdown)
	}
	if strings.Contains(markdown, "\n1\n") {
		t.Fatalf("gutter line numbers leaked into the code block:\n%s", markdown)
	}
}

func TestRunRejectsOversizedInput(t *testing.T) {
	var stdout bytes.Buffer
	err := run(strings.NewReader(strings.Repeat("a", maxInputBytes+1)), &stdout, nil)
	if err == nil {
		t.Fatal("expected an oversized input error")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunVersion(t *testing.T) {
	var stdout bytes.Buffer
	if err := run(strings.NewReader(""), &stdout, []string{"--version"}); err != nil {
		t.Fatalf("version: %v", err)
	}
	if !strings.Contains(stdout.String(), "webmesh-html-to-markdown/1") {
		t.Fatalf("unexpected version output: %q", stdout.String())
	}
}
