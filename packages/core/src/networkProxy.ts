import { RequestError, Server } from "proxy-chain";
import { blockedHostname, type ResolveAddresses } from "./network";

type NetworkProxyOptions = {
  upstreamProxy?: string;
  directHosts?: string[];
  resolve?: ResolveAddresses;
};

const goesDirect = (hostname: string, patterns: string[]) =>
  patterns.some((pattern) => {
    const host = pattern.replace(/^\*\./, "");
    return hostname === host || (pattern.startsWith("*.") && hostname.endsWith(`.${host}`));
  });

export async function startNetworkProxy({ upstreamProxy, directHosts = [], resolve }: NetworkProxyOptions = {}) {
  const server = new Server({
    host: "127.0.0.1",
    port: 0,
    // SAFETY: This hook runs before proxy-chain opens a target connection.
    async prepareRequestFunction({ hostname }) {
      const error = await blockedHostname(hostname, resolve);
      if (error) throw new RequestError(error, 403);
      return { upstreamProxyUrl: upstreamProxy && !goesDirect(hostname, directHosts) ? upstreamProxy : undefined };
    },
  });
  await server.listen();
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.close(true),
  };
}
