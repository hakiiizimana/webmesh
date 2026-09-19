import { expect, test } from "bun:test";
import { startNetworkProxy } from "../src/networkProxy";

test("blocks browser proxy requests to private destinations", async () => {
  let requests = 0;
  const destination = Bun.serve({ port: 0, fetch: () => new Response(String(++requests)) });
  const proxy = await startNetworkProxy();
  try {
    const response = await fetch(`http://127.0.0.1:${destination.port}`, { proxy: proxy.url });

    expect(response.status).toBe(403);
    expect(requests).toBe(0);
  } finally {
    await proxy.close();
    destination.stop(true);
  }
});

test("resolves browser proxy hostnames before connecting", async () => {
  const proxy = await startNetworkProxy({ resolve: async () => [{ address: "10.0.0.8", family: 4 }] });
  try {
    const response = await fetch("http://public.example/secret", { proxy: proxy.url });

    expect(response.status).toBe(403);
  } finally {
    await proxy.close();
  }
});
