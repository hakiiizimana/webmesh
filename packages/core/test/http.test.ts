import { expect, test } from "bun:test";
import { parseRetryAfter, request, ResponseTooLargeError } from "../src/http";

test("stops reading a body that grows past the limit, even without a content-length", async () => {
  const chunk = new Uint8Array(64 * 1024);
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
      ),
  });
  try {
    const call = request(`http://127.0.0.1:${server.port}`, { signal: AbortSignal.timeout(5_000), maxBytes: 256 * 1024 });

    await expect(call).rejects.toBeInstanceOf(ResponseTooLargeError);
  } finally {
    server.stop(true);
  }
});

test("caps Retry-After and reads the HTTP-date form", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  expect(parseRetryAfter("86400", "", now)).toBe(900);
  expect(parseRetryAfter("30", "", now)).toBe(30);
  expect(parseRetryAfter("Wed, 23 Sep 2026 12:02:00 GMT", "", now)).toBe(120);
  expect(parseRetryAfter("Wed, 23 Sep 2026 11:00:00 GMT", "", now)).toBe(0);
  expect(parseRetryAfter(null, '{"retry_after_seconds": 45}', now)).toBe(45);
  expect(parseRetryAfter(null, "", now)).toBeUndefined();
});
