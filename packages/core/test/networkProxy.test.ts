import { expect, test } from "bun:test";
import { pinnedLookup, startNetworkProxy } from "../src/networkProxy";

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

test("connects to the vetted address instead of resolving the name again", () => {
  const lookup = pinnedLookup([
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::1", family: 6 },
  ]);
  const answers: unknown[] = [];
  lookup("rebind.example", {}, (_error, address, family) => answers.push([address, family]));
  lookup("rebind.example", { all: true, family: 6 }, (_error, address) => answers.push(address));

  expect(answers).toEqual([
    ["93.184.216.34", 4],
    [{ address: "2606:2800:220:1::1", family: 6 }],
  ]);
});

test("lets the browser reach an allowed local port and nothing else", async () => {
  const allowed = Bun.serve({ port: 0, fetch: () => new Response("dev server") });
  const other = Bun.serve({ port: 0, fetch: () => new Response("database") });
  const proxy = await startNetworkProxy({ allowedHosts: [`127.0.0.1:${allowed.port}`] });
  try {
    const reached = await fetch(`http://127.0.0.1:${allowed.port}`, { proxy: proxy.url });
    const refused = await fetch(`http://127.0.0.1:${other.port}`, { proxy: proxy.url });

    expect(await reached.text()).toBe("dev server");
    expect(refused.status).toBe(403);
  } finally {
    await proxy.close();
    allowed.stop(true);
    other.stop(true);
  }
});
