import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

const resolveAddresses: ResolveAddresses = (hostname) => lookup(hostname, { all: true });

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return blocked.check(address, "ipv6") || (mapped !== undefined && blocked.check(mapped, "ipv4"));
}

export async function blockedUrl(url: string, resolve: ResolveAddresses = resolveAddresses): Promise<string | undefined> {
  const parsed = URL.parse(url);
  if (!parsed) return "Invalid URL.";
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  return blockedHostname(hostname, resolve);
}

export async function blockedHostname(hostname: string, resolve: ResolveAddresses = resolveAddresses): Promise<string | undefined> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return `Could not resolve ${hostname}.`;
  }
  if (addresses.length === 0) return `Could not resolve ${hostname}.`;
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    return "Loopback, private, and link-local addresses are blocked. Set allowPrivateNetworks to true in webmesh config to allow them.";
  }
  return undefined;
}
