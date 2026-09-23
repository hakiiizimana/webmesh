import type { lookup, LookupAddress, LookupOptions } from "node:dns";
import { RequestError, Server } from "proxy-chain";
import { isAllowedHost, vetHostname, type ResolvedAddress, type ResolveAddresses } from "./network";

type NetworkProxyOptions = {
  upstreamProxy?: string;
  directHosts?: string[];
  allowedHosts?: readonly string[];
  resolve?: ResolveAddresses;
  port?: number;
};

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const goesDirect = (hostname: string, patterns: string[]) =>
  patterns.some((pattern) => {
    const host = pattern.replace(/^\*\./, "");
    return hostname === host || (pattern.startsWith("*.") && hostname.endsWith(`.${host}`));
  });

// Answers the socket's DNS lookup with the addresses already vetted, so a second
// resolution cannot swap in a private address (DNS rebinding).
export function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const matching = addresses.filter(({ family }) => !options.family || family === options.family);
    const first = matching[0];
    if (!first) {
      callback(Object.assign(new Error("no vetted address for this family"), { code: "ENOTFOUND" }), []);
      return;
    }
    if (options.all) callback(null, matching.map(({ address, family }) => ({ address, family })));
    else callback(null, first.address, first.family);
  };
}

export async function startNetworkProxy({ upstreamProxy, directHosts = [], allowedHosts = [], resolve, port = 0 }: NetworkProxyOptions = {}) {
  const server = new Server({
    host: "127.0.0.1",
    port,
    // SAFETY: This hook runs before proxy-chain opens a target connection.
    async prepareRequestFunction({ hostname, port: targetPort }) {
      // An allowed host is on this machine or network, so it never goes through the upstream proxy.
      if (isAllowedHost(hostname, targetPort, allowedHosts)) return {};
      const vetted = await vetHostname(hostname.replace(/^\[|\]$/g, ""), resolve);
      if ("error" in vetted) throw new RequestError(vetted.error, 403);
      const upstreamProxyUrl = upstreamProxy && !goesDirect(hostname, directHosts) ? upstreamProxy : undefined;
      // An upstream proxy resolves the name itself, so there is no local connection to pin.
      if (upstreamProxyUrl) return { upstreamProxyUrl };
      // SAFETY: net.connect only calls a lookup as (hostname, options, callback), which pinnedLookup implements.
      return { dnsLookup: pinnedLookup(vetted.addresses) as typeof lookup };
    },
  });
  await server.listen();
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    server,
    close: () => server.close(true),
  };
}
