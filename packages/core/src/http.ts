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

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type HttpResponse = {
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
};

const CHROME = "chrome";
const LINUX = "linux";
const sessions = new Map<string, Promise<Session>>();

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

function parseRetryAfter(res: HttpResponse, body: string): number | undefined {
  const header = res.headers.get("retry-after");
  if (header && /^\d+$/.test(header)) return Number(header);
  const match = body.match(/"retry_after_seconds"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function send(url: string, options: RequestOptions): Promise<HttpResponse> {
  const { browser, proxy, ...init } = options;
  try {
    if (browser) return await (await browserSession(proxy)).fetch(url, init);
    return await fetch(url, proxy ? { ...init, proxy } : init);
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new NetworkError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

export async function request(url: string, options: RequestOptions): Promise<HttpResponse> {
  const res = await send(url, options);
  if (res.ok || (options.redirect === "manual" && res.status >= 300 && res.status < 400)) return res;
  const body = await res.text();
  throw new HttpError(res.status, parseRetryAfter(res, body), `HTTP ${res.status}: ${body.slice(0, 200)}`);
}
