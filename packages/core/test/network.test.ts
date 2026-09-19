import { expect, test } from "bun:test";
import { blockedUrl, isBlockedAddress } from "../src/network";

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
  ];
  const publicAddresses = ["8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888"];

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
