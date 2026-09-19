import { expect, test } from "bun:test";
import { probe } from "../src/check";
import { SoftBlockError } from "../src/html";
import { HttpError, NetworkError } from "../src/http";

test("separates a provider that needs a fix from one that is only blocked or down", async () => {
  const status = async (err: Error) => (await probe("search", "p", () => Promise.reject(err))).status;

  const ok = await probe("search", "p", () => Bun.sleep(20).then(() => "3 results"));
  expect(ok.status).toBe("ok");
  expect(ok.ms).toBeGreaterThanOrEqual(15);
  expect(await status(new HttpError(202, undefined, "bot check"))).toBe("unavailable");
  expect(await status(new HttpError(503, undefined, "down"))).toBe("unavailable");
  expect(await status(new NetworkError("reset"))).toBe("unavailable");
  expect(await status(new SoftBlockError("off-topic"))).toBe("unavailable");
  expect(await status(new SyntaxError("Unexpected token <"))).toBe("broken");
  expect(await status(new Error("no results"))).toBe("broken");
  expect(await status(new HttpError(404, undefined, "moved"))).toBe("broken");
});
