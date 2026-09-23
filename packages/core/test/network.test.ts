import { expect, test } from "bun:test";
import { blockedUrl, isBlockedAddress, privateHostKey } from "../src/network";

test("identifies loopback, private, and link-local IP ranges", () => {
  const privateAddresses = [
    "127.255.255.255",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    // Linux and macOS route the unspecified address to this machine.
    "0.0.0.0",
    "::",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "ff02::1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "2002:c0a8:101::1",
  ];
  const publicAddresses = [
    "8.8.8.8",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "2001:4860:4860::8888",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ];

  expect(privateAddresses.every(isBlockedAddress)).toBe(true);
  expect(publicAddresses.every((address) => !isBlockedAddress(address))).toBe(true);
});

test("blocks a hostname when any DNS answer is private", async () => {
  const seen: string[] = [];
  const error = await blockedUrl("https://mixed.example/path", async (hostname) => {
    seen.push(hostname);
    return [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.2", family: 4 },
    ];
  });

  expect(seen).toEqual(["mixed.example"]);
  expect(error).toContain("private");
});

test("an allowed host opens exactly that host and port", async () => {
  const loopback = async () => [{ address: "127.0.0.1", family: 4 }];
  const allowed = ["localhost:3000", "[::1]:8080"];

  expect(await blockedUrl("http://localhost:3000/app", loopback, allowed)).toBeUndefined();
  expect(await blockedUrl("http://LOCALHOST:3000/", loopback, allowed)).toBeUndefined();
  expect(await blockedUrl("http://[::1]:8080/", loopback, allowed)).toBeUndefined();
  expect(await blockedUrl("http://localhost:3001/", loopback, allowed)).toContain("private");
  expect(await blockedUrl("http://127.0.0.1:3000/", loopback, allowed)).toContain("private");
  expect(await blockedUrl("http://localhost/", loopback, ["localhost:80"])).toBeUndefined();
  expect(await blockedUrl("https://localhost/", loopback, ["localhost:80"])).toContain("private");
});

test("reads allowPrivateHosts entries only as host:port", () => {
  expect(privateHostKey("localhost:3000")).toBe("localhost:3000");
  expect(privateHostKey(" 192.168.1.20:8123 ")).toBe("192.168.1.20:8123");
  expect(privateHostKey("[::1]:8080")).toBe("[::1]:8080");
  expect(["localhost", "localhost:0", "localhost:70000", "http://localhost:3000", "localhost:3000/x", ":3000"].map(privateHostKey)).toEqual(
    Array.from({ length: 6 }, () => undefined),
  );
});
