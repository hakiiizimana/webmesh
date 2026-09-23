import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("224.0.0.0", 3, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

const resolveAddresses: ResolveAddresses = (hostname) => lookup(hostname, { all: true });

// The URL parser writes IPv6 in compressed hex, dotted IPv4 tails included, so only `::` needs expanding.
function hextets(address: string): number[] {
  const [head = "", tail = ""] = new URL(`http://[${address}]`).hostname.slice(1, -1).split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...zeros, ...right].map((part) => parseInt(part, 16));
}

const ipv4 = (high = 0, low = 0) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

// IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) reach an IPv4 host.
function embeddedIpv4(address: string): string | undefined {
  const [a, b, c, d, e, f, g, h] = hextets(address);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return ipv4(g, h);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return ipv4(g, h);
  if (a === 0x2002) return ipv4(b, c);
  return undefined;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return false;
  if (blocked.check(address, "ipv6")) return true;
  const embedded = embeddedIpv4(address);
  return embedded !== undefined && blocked.check(embedded, "ipv4");
}

const HOST_PORT = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i;

// An allowPrivateHosts entry as `host:port`, normalized the way URLs write hosts, or undefined.
export function privateHostKey(entry: string): string | undefined {
  const match = entry.trim().match(HOST_PORT);
  const port = Number(match?.[2]);
  const hostname = match ? URL.parse(`http://${match[1]}`)?.hostname : undefined;
  if (!hostname || port < 1 || port > 65_535) return undefined;
  return `${hostname}:${port}`;
}

// Exact host and port: allowing localhost:3000 opens neither localhost:8080 nor 127.0.0.1:3000.
export function isAllowedHost(hostname: string, port: number, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  const bare = hostname.replace(/^\[|\]$/g, "");
  const key = privateHostKey(`${bare.includes(":") ? `[${bare}]` : bare}:${port}`);
  return key !== undefined && allowed.some((entry) => privateHostKey(entry) === key);
}

export async function blockedUrl(
  url: string,
  resolve: ResolveAddresses = resolveAddresses,
  allowedHosts: readonly string[] = [],
): Promise<string | undefined> {
  const parsed = URL.parse(url);
  if (!parsed) return "Invalid URL.";
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (isAllowedHost(parsed.hostname, port, allowedHosts)) return undefined;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  return blockedHostname(hostname, resolve);
}

export type VettedHost = { error: string } | { addresses: readonly ResolvedAddress[] };

// Returns the addresses that passed, so a caller can connect to exactly those and not re-resolve.
export async function vetHostname(hostname: string, resolve: ResolveAddresses = resolveAddresses): Promise<VettedHost> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { error: `Could not resolve ${hostname}.` };
  }
  if (addresses.length === 0) return { error: `Could not resolve ${hostname}.` };
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    return {
      error:
        "Loopback, private, and link-local addresses are blocked. Allow one with `webmesh setup allow host:port`, " +
        "or set allowPrivateNetworks to true in webmesh config to allow them all.",
    };
  }
  return { addresses };
}

export async function blockedHostname(hostname: string, resolve: ResolveAddresses = resolveAddresses): Promise<string | undefined> {
  const vetted = await vetHostname(hostname, resolve);
  return "error" in vetted ? vetted.error : undefined;
}
