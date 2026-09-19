import { Impit } from "impit";

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

type HttpResponse = Pick<Response, "ok" | "status" | "headers" | "text">;

type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  browser?: boolean;
  proxy?: string;
};

function createCookieJar() {
  const byHost = new Map<string, Map<string, string>>();
  const host = (url: string) => URL.parse(url)?.hostname ?? "";
  return {
    getCookieString: (url: string) => [...(byHost.get(host(url))?.values() ?? [])].join("; "),
    setCookie: (cookie: string, url: string) => {
      const pair = cookie.split(";", 1)[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq < 1) return;
      const jar = byHost.get(host(url)) ?? new Map<string, string>();
      jar.set(pair.slice(0, eq), pair);
      byHost.set(host(url), jar);
    },
  };
}

const clients = new Map<string, Impit>();
function browserClient(proxy: string | undefined): Impit {
  const existing = clients.get(proxy ?? "");
  if (existing) return existing;
  const client = new Impit({ browser: "chrome", cookieJar: createCookieJar(), proxyUrl: proxy });
  clients.set(proxy ?? "", client);
  return client;
}

function parseRetryAfter(res: HttpResponse, body: string): number | undefined {
  const header = res.headers.get("retry-after");
  if (header && /^\d+$/.test(header)) return Number(header);
  const match = body.match(/"retry_after_seconds"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function send(url: string, { browser, proxy, ...init }: RequestOptions): Promise<HttpResponse> {
  try {
    if (browser) return await browserClient(proxy).fetch(url, init);
    return await fetch(url, proxy ? { ...init, proxy } : init);
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new NetworkError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

export async function request(url: string, options: RequestOptions): Promise<HttpResponse> {
  const res = await send(url, options);
  if (res.ok) return res;
  const body = await res.text();
  throw new HttpError(res.status, parseRetryAfter(res, body), `HTTP ${res.status}: ${body.slice(0, 200)}`);
}
