import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { captionToMarkdown, extractYtDlpMetadata, memoryYtDlpCache } from "../src/read/providers/ytDlp";

const makeFake = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "webmesh-ytdlp-"));
  const path = join(directory, "yt-dlp");
  await Bun.write(path, `#!/usr/bin/env bun\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

const removeFake = async (path: string): Promise<void> => {
  await rm(join(path, ".."), { recursive: true, force: true });
};

test("extracts metadata with bounded yt-dlp arguments", async () => {
  const executablePath = await makeFake(`
const args = process.argv.slice(2);
console.log(JSON.stringify({
  id: "demo",
  title: "Demo",
  description: JSON.stringify(args),
  duration: 12.5,
  uploader: "Channel",
  upload_date: "20240102",
  thumbnail: "https://example.test/thumb.jpg"
  ,extractor_key: "Instagram"
  ,webpage_url_domain: "instagram.com"
  ,uploader_id: "creator-id"
  ,uploader_url: "https://instagram.com/creator"
  ,view_count: 100
  ,like_count: 12
  ,comment_count: 3
  ,repost_count: 2
  ,tags: ["demo", "social"]
  ,categories: ["People"]
  ,chapters: [{ title: "Intro", start_time: 0, end_time: 5 }]
  ,subtitles: { en: [{ ext: "vtt", name: "English", url: "https://temporary.test/manual" }] }
  ,automatic_captions: { es: [{ ext: "json3", name: "Spanish", protocol: "https", url: "https://temporary.test/auto" }] }
}));`);
  try {
    const result = await extractYtDlpMetadata("https://example.test/video", {
      executablePath,
      proxy: "http://proxy.test:8080",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      id: "demo",
      site: "instagram.com",
      extractor: "Instagram",
      mediaType: "video",
      title: "Demo",
      description: JSON.stringify([
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--retries",
        "3",
        "--proxy",
        "http://proxy.test:8080",
        "https://example.test/video",
      ]),
      url: "https://example.test/video",
      durationSeconds: 12.5,
      creator: "Channel",
      creatorId: "creator-id",
      creatorUrl: "https://instagram.com/creator",
      publishedAt: "2024-01-02",
      thumbnail: "https://example.test/thumb.jpg",
      engagement: { views: 100, likes: 12, comments: 3, reposts: 2 },
      tags: ["demo", "social"],
      categories: ["People"],
      chapters: [{ title: "Intro", startSeconds: 0, endSeconds: 5 }],
      captions: [
        { language: "en", name: "English", automatic: false, formats: [{ extension: "vtt", name: "English", protocol: null }] },
        { language: "es", name: "Spanish", automatic: true, formats: [{ extension: "json3", name: "Spanish", protocol: "https" }] },
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain("temporary.test");
  } finally {
    await removeFake(executablePath);
  }
});

test("turns VTT and JSON3 captions into readable markdown", () => {
  expect(captionToMarkdown("WEBVTT\n\n00:00.000 --> 00:01.000\nHello <b>world</b>\n\n00:01.000 --> 00:02.000\nHello world\n\n00:02.000 --> 00:03.000\nNext line", "vtt"))
    .toBe("Hello world\n\nNext line");
  expect(captionToMarkdown(JSON.stringify({ events: [{ segs: [{ utf8: "First " }, { utf8: "line" }] }, { segs: [{ utf8: "Second" }] }] }), "json3"))
    .toBe("First line\n\nSecond");
});

test("downloads the requested caption language and keeps its URL private", async () => {
  const captions = Bun.serve({
    port: 0,
    fetch: (request) => new Response(new URL(request.url).pathname === "/fr" ? "WEBVTT\n\n00:00.000 --> 00:01.000\nBonjour" : "WEBVTT\n\n00:00.000 --> 00:01.000\nHello"),
  });
  const executablePath = await makeFake(`console.log(JSON.stringify({
    id: "captions",
    title: "Captions",
    subtitles: {
      en: [{ ext: "vtt", url: "http://127.0.0.1:${captions.port}/en" }],
      fr: [{ ext: "vtt", url: "http://127.0.0.1:${captions.port}/fr" }]
    }
  }));`);
  try {
    const result = await extractYtDlpMetadata("https://social.test/captions", {
      executablePath,
      language: "fr-FR",
      cache: false,
      allowPrivateNetworks: true,
    });
    expect(result.success && result.data.transcript).toBe("Bonjour");
    expect(JSON.stringify(result)).not.toContain(`127.0.0.1:${captions.port}`);
  } finally {
    captions.stop(true);
    await removeFake(executablePath);
  }
});

test("caches successful extractions", async () => {
  const executablePath = await makeFake(`
const marker = import.meta.dir + "/count";
const count = Number(await Bun.file(marker).text().catch(() => "0")) + 1;
await Bun.write(marker, String(count));
console.log(JSON.stringify({ id: "cached", title: "Cached", description: String(count), duration: 1 }));`);
  const cache = memoryYtDlpCache();
  try {
    const options = { executablePath, cache, now: () => 1_000 };
    const first = await extractYtDlpMetadata("https://social.test/post", options);
    const second = await extractYtDlpMetadata("https://social.test/post", options);
    expect(first).toEqual(second);
    expect(first.success && first.data.description).toBe("1");
  } finally {
    await removeFake(executablePath);
  }
});

test("expires cached extractions after the configured ttl", async () => {
  const executablePath = await makeFake(`
const marker = import.meta.dir + "/count";
const count = Number(await Bun.file(marker).text().catch(() => "0")) + 1;
await Bun.write(marker, String(count));
console.log(JSON.stringify({ id: "cached", title: "Cached", description: String(count), duration: 1 }));`);
  const cache = memoryYtDlpCache();
  let now = 1_000;
  try {
    const options = { executablePath, cache, cacheTtlMs: 50, now: () => now };
    const first = await extractYtDlpMetadata("https://social.test/expiring", options);
    now = 1_051;
    const second = await extractYtDlpMetadata("https://social.test/expiring", options);
    expect(first.success && first.data.description).toBe("1");
    expect(second.success && second.data.description).toBe("2");
  } finally {
    await removeFake(executablePath);
  }
});

test("returns a typed failure for a nonzero fake executable", async () => {
  const executablePath = await makeFake('console.error("fake failure"); process.exit(7);');
  try {
    const result = await extractYtDlpMetadata("https://example.test/video", { executablePath });
    expect(result).toEqual({
      success: false,
      error: { kind: "exit", message: "fake failure", exitCode: 7 },
    });
  } finally {
    await removeFake(executablePath);
  }
});

test("caps output and kills the fake executable", async () => {
  const executablePath = await makeFake('process.stdout.write("x".repeat(1024)); await Bun.sleep(10000);');
  try {
    const result = await extractYtDlpMetadata("https://example.test/video", { executablePath, maxOutputBytes: 64 });
    expect(result).toEqual({
      success: false,
      error: { kind: "output-limit", message: "yt-dlp output exceeded 64 bytes" },
    });
  } finally {
    await removeFake(executablePath);
  }
});

test("enforces the timeout for a running fake executable", async () => {
  const executablePath = await makeFake("await Bun.sleep(10000);");
  try {
    const result = await extractYtDlpMetadata("https://example.test/video", { executablePath, timeoutMs: 50 });
    expect(result).toEqual({ success: false, error: { kind: "timeout", message: "yt-dlp timed out after 50ms" } });
  } finally {
    await removeFake(executablePath);
  }
});

test("cancels a running fake executable", async () => {
  const executablePath = await makeFake("await Bun.sleep(10000);");
  const controller = new AbortController();
  try {
    const promise = extractYtDlpMetadata("https://example.test/video", { executablePath, signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ success: false, error: { kind: "cancelled", message: "yt-dlp was cancelled" } });
  } finally {
    await removeFake(executablePath);
  }
});
