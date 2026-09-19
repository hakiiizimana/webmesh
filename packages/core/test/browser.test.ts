import { expect, test } from "bun:test";
import { parseOutput } from "../src/browser";

const lifecycle = { launched: false, reused: true, restoreStatus: "not_configured" };

test("keeps what the agent needs from a snapshot and drops the noise", () => {
  const stdout = JSON.stringify({
    success: true,
    data: {
      lifecycle,
      origin: "https://example.com/",
      refs: { e2: { name: "Learn more", role: "link" } },
      snapshot: '- link "Learn more" [ref=e2]',
    },
    error: null,
  });

  expect(parseOutput(stdout, "", 0)).toEqual({
    success: true,
    data: { origin: "https://example.com/", snapshot: '- link "Learn more" [ref=e2]' },
  });
});

test("adds a next step to stale-ref and missing-Chrome errors", () => {
  const stale = parseOutput(JSON.stringify({ success: false, data: null, error: "Unknown ref: e99" }), "", 1);
  const noChrome = parseOutput(JSON.stringify({ success: false, error: 'Failed to launch Chrome at "/x": No such file' }), "", 1);

  expect(stale).toEqual({ success: false, error: "Unknown ref: e99. Refs change when the page changes; run snapshot -i again." });
  expect(!noChrome.success && noChrome.error).toContain("webmesh browser install");
});

test("cuts oversized fields and keeps plain-text output", () => {
  const long = parseOutput(JSON.stringify({ success: true, data: { content: "x".repeat(40_000) } }), "", 0);
  const text = parseOutput("agent-browser 0.38.1\n", "", 0);

  expect(long.success && String(long.data.content).length).toBeLessThan(31_000);
  expect(text).toEqual({ success: true, data: { output: "agent-browser 0.38.1" } });
});
