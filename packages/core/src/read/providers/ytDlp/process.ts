import { existsSync } from "node:fs";
import { join } from "node:path";
import type { YtDlpError, YtDlpErrorKind } from "./index";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;
const RETRIES = "3";

const bundledYtDlpPath = join(import.meta.dir, "../../../../bin/yt-dlp");
export const defaultYtDlpPath = existsSync(bundledYtDlpPath) ? bundledYtDlpPath : Bun.which("yt-dlp") ?? bundledYtDlpPath;

type SettledOutput = PromiseSettledResult<string>;
class OutputLimitError extends Error {}

export type YtDlpFailure = { readonly success: false; readonly error: YtDlpError };

export const failure = (kind: YtDlpErrorKind, message: string, exitCode?: number): YtDlpFailure => ({
  success: false,
  error: exitCode === undefined ? { kind, message } : { kind, message, exitCode },
});

const outputError = (result: SettledOutput): YtDlpError | null => {
  if (result.status === "fulfilled") return null;
  if (result.reason instanceof OutputLimitError) return { kind: "output-limit", message: result.reason.message };
  return { kind: "exit", message: result.reason instanceof Error ? result.reason.message : "yt-dlp output could not be read" };
};

const outputText = (result: SettledOutput): string => result.status === "fulfilled" ? result.value : "";

async function readOutput(stream: ReadableStream<Uint8Array<ArrayBuffer>>, maxBytes: number, budget: { bytes: number }, onLimit: () => void): Promise<string> {
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
        throw new OutputLimitError(`yt-dlp output exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export type YtDlpProcessOptions = {
  executablePath?: string;
  proxy?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type YtDlpProcessResult = { success: true; stdout: string } | YtDlpFailure;

export async function runYtDlp(sourceUrl: string, options: YtDlpProcessOptions): Promise<YtDlpProcessResult> {
  const { executablePath, proxy, signal, timeoutMs, maxOutputBytes } = options;
  const args = [executablePath ?? defaultYtDlpPath, "--dump-single-json", "--skip-download", "--no-playlist", "--retries", RETRIES,
    ...(proxy === undefined ? [] : ["--proxy", proxy]), sourceUrl];
  let process: Bun.Subprocess;
  try {
    process = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return failure("spawn", `yt-dlp could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  let cancelled = false;
  let timedOut = false;
  const kill = (): void => process.kill();
  const cancel = (): void => { cancelled = true; kill(); };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const stdoutStream = process.stdout;
  const stderrStream = process.stderr;
  if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
    kill(); await process.exited; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    return failure("spawn", "yt-dlp did not expose piped output");
  }
  const budget = { bytes: 0 };
  const [stdout, stderr] = await Promise.allSettled([
    readOutput(stdoutStream, maxOutputBytes, budget, kill),
    readOutput(stderrStream, maxOutputBytes, budget, kill),
  ]);
  const exitCode = await process.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", cancel);
  if (cancelled) return failure("cancelled", "yt-dlp was cancelled");
  if (timedOut) return failure("timeout", `yt-dlp timed out after ${timeoutMs}ms`);
  const streamError = outputError(stdout) ?? outputError(stderr);
  if (streamError) return { success: false, error: streamError };
  if (exitCode !== 0) return failure("exit", outputText(stderr).trim().split("\n")[0] || `yt-dlp exited with code ${exitCode}`, exitCode);
  return { success: true, stdout: outputText(stdout) };
}
