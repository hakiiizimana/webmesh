import { createSession, type Session } from "wreq-js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {}

export class ResponseTooLargeError extends Error {}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Bodies are read in full and capped, so one huge or endless response cannot exhaust memory.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 15 * 60;

type Source = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export type HttpResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
};

type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  browser?: boolean;
  proxy?: string;
  redirect?: "follow" | "manual" | "error";
  maxBytes?: number;
};

const CHROME = "chrome";
const LINUX = "linux";
const sessions = new Map<string, Promise<Session>>();
const decoder = new TextDecoder();

function browserSession(proxy: string | undefined): Promise<Session> {
  const key = proxy ?? "";
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = createSession({ browser: CHROME, os: LINUX, proxy }).catch((error) => {
    sessions.delete(key);
    throw error;
  });
  sessions.set(key, created);
  return created;
}

// Seconds, capped so one bad header cannot bench a provider for every session for a day.
export function parseRetryAfter(header: string | null, body: string, now = Date.now()): number | undefined {
  const seconds = retryAfterSeconds(header, body, now);
  return seconds === undefined ? undefined : Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

function retryAfterSeconds(header: string | null, body: string, now: number): number | undefined {
  if (header && /^\d+$/.test(header)) return Number(header);
  const date = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(date)) return Math.ceil((date - now) / 1000);
  const fromBody = body.match(/"retry_after_seconds"\s*:\s*(\d+)/)?.[1];
  return fromBody === undefined ? undefined : Number(fromBody);
}

async function readBody(source: Source, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(source.headers.get("content-length"));
  if (declared > maxBytes) throw new ResponseTooLargeError(`response is larger than ${maxBytes} bytes`);
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(`response is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function send(url: string, options: RequestOptions): Promise<HttpResponse> {
  const { browser, proxy, maxBytes = MAX_BODY_BYTES, ...init } = options;
  try {
    const source: Source = browser
      ? await (await browserSession(proxy)).fetch(url, init)
      : await fetch(url, proxy ? { ...init, proxy } : init);
    const bytes = await readBody(source, maxBytes);
    return {
      ok: source.ok,
      status: source.status,
      headers: source.headers,
      text: async () => decoder.decode(bytes),
      bytes: async () => bytes,
    };
  } catch (err) {
    if (init.signal.aborted || err instanceof ResponseTooLargeError) throw err;
    throw new NetworkError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

export async function request(url: string, options: RequestOptions): Promise<HttpResponse> {
  const res = await send(url, options);
  if (res.ok || (options.redirect === "manual" && res.status >= 300 && res.status < 400)) return res;
  const body = await res.text();
  throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after"), body), `HTTP ${res.status}: ${body.slice(0, 200)}`);
}
