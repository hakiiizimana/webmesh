import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_INPUT_BYTES = 8_388_608;
export const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;

export type HtmlToMarkdownErrorKind =
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "input-limit"
  | "output-limit"
  | "spawn"
  | "exit";

export type HtmlToMarkdownError = {
  readonly kind: HtmlToMarkdownErrorKind;
  readonly message: string;
  readonly exitCode?: number;
};

export type HtmlToMarkdownResult =
  | { readonly success: true; readonly markdown: string }
  | { readonly success: false; readonly error: HtmlToMarkdownError };

export type HtmlToMarkdownOptions = {
  readonly executablePath?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
};

const BINARY = "html-to-markdown";
const encoder = new TextEncoder();
class OutputLimitError extends Error {}

function binaryName(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return `${BINARY}-${process.platform}-${process.arch}${suffix}`;
}

let cached: string | null | undefined;

// Source and bundled layouts place binaries in different roots.
export function htmlToMarkdownPath(): string | null {
  if (cached !== undefined) return cached;
  const name = binaryName();
  const roots = [join(import.meta.dir, "../../../bin"), join(import.meta.dir, "bin"), join(import.meta.dir, "..", "bin")];
  cached = roots.map((root) => join(root, name)).find((path) => existsSync(path)) ?? null;
  return cached;
}

const failure = (kind: HtmlToMarkdownErrorKind, message: string, exitCode?: number): HtmlToMarkdownResult => ({
  success: false,
  error: exitCode === undefined ? { kind, message } : { kind, message, exitCode },
});

async function readOutput(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  maxBytes: number,
  budget: { bytes: number },
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      budget.bytes += chunk.value.byteLength;
      if (budget.bytes > maxBytes) {
        onLimit();
        throw new OutputLimitError(`html-to-markdown output exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function streamError(result: PromiseSettledResult<string>): HtmlToMarkdownError | null {
  if (result.status === "fulfilled") return null;
  if (result.reason instanceof OutputLimitError) return { kind: "output-limit", message: result.reason.message };
  return { kind: "exit", message: result.reason instanceof Error ? result.reason.message : "html-to-markdown output could not be read" };
}

const streamText = (result: PromiseSettledResult<string>): string => (result.status === "fulfilled" ? result.value : "");

export async function runHtmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): Promise<HtmlToMarkdownResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return failure("unavailable", "timeoutMs must be greater than zero");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) return failure("unavailable", "maxOutputBytes must be a positive integer");
  if (options.signal?.aborted) return failure("cancelled", "html-to-markdown was cancelled");
  const executablePath = options.executablePath ?? htmlToMarkdownPath();
  if (!executablePath) return failure("unavailable", "html-to-markdown binary is not installed");
  const input = encoder.encode(html);
  if (input.byteLength > maxInputBytes) {
    return failure("input-limit", `html-to-markdown input exceeded ${maxInputBytes} bytes`);
  }

  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([executablePath], { stdin: input, stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return failure("spawn", `html-to-markdown could not start: ${error instanceof Error ? error.message : String(error)}`);
  }

  let cancelled = false;
  let timedOut = false;
  const kill = (): void => child.kill();
  const cancel = (): void => {
    cancelled = true;
    kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
    kill();
    await child.exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    return failure("spawn", "html-to-markdown did not expose piped output");
  }

  const budget = { bytes: 0 };
  const [stdout, stderr] = await Promise.allSettled([
    readOutput(stdoutStream, maxOutputBytes, budget, kill),
    readOutput(stderrStream, maxOutputBytes, budget, kill),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", cancel);

  if (cancelled) return failure("cancelled", "html-to-markdown was cancelled");
  if (timedOut) return failure("timeout", `html-to-markdown timed out after ${timeoutMs}ms`);
  const error = streamError(stdout) ?? streamError(stderr);
  if (error) return { success: false, error };
  if (exitCode !== 0) {
    const detail = streamText(stderr).trim().split("\n")[0] || `html-to-markdown exited with code ${exitCode}`;
    return failure("exit", detail, exitCode);
  }
  return { success: true, markdown: streamText(stdout) };
}

// Keep Defuddle's markdown when the converter is unavailable or fails.
export async function convertHtmlToMarkdown(
  html: string,
  fallback: string,
  options: HtmlToMarkdownOptions = {},
): Promise<string> {
  const result = await runHtmlToMarkdown(html, options);
  if (result.success && result.markdown.trim().length > 0) return result.markdown;
  return fallback;
}
