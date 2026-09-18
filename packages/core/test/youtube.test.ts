import { expect, test } from "bun:test";
import {
  parseYoutubeSearchResponse,
  youtubeSearchBodyFor,
  youtubeSearchParamsFor,
} from "../src/youtube";

test("parses legacy YouTube video renderers into the public result shape", () => {
  const items = parseYoutubeSearchResponse(
    JSON.stringify({
      contents: [
        {
          videoRenderer: {
            videoId: "demo",
            title: { simpleText: "Demo" },
            descriptionSnippet: { runs: [{ text: "A demo." }] },
          },
        },
      ],
    }),
  );

  expect(items).toEqual([
    {
      title: "Demo",
      url: "https://www.youtube.com/watch?v=demo",
      description: "A demo.",
    },
  ]);
});

test("parses current lockup video renderers", () => {
  const items = parseYoutubeSearchResponse(
    JSON.stringify({
      contents: [
        {
          lockupViewModel: {
            contentId: "lockup-id",
            contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
            metadata: {
              lockupMetadataViewModel: {
                title: { content: "Lockup video" },
              },
            },
          },
        },
      ],
    }),
  );

  expect(items).toEqual([
    {
      title: "Lockup video",
      url: "https://www.youtube.com/watch?v=lockup-id",
      description: "",
    },
  ]);
});

test("parses Shorts shelf renderers", () => {
  const items = parseYoutubeSearchResponse(
    JSON.stringify({
      contents: [
        {
          shortsLockupViewModel: {
            entityId: "shorts-shelf-item-short-id",
            onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: "short-id" } } },
            overlayMetadata: { primaryText: { content: "Short title" } },
          },
        },
      ],
    }),
  );

  expect(items).toEqual([
    {
      title: "Short title",
      url: "https://www.youtube.com/watch?v=short-id",
      description: "",
    },
  ]);
});

test("encodes InnerTube video filters", () => {
  expect(youtubeSearchParamsFor({ type: "video" })).toBe("EgIQAQ==");
  expect(youtubeSearchParamsFor({ type: "video", freshness: "week" })).toBe("EgQIAxAB");
});

test("builds an InnerTube search body with region and language", () => {
  expect(youtubeSearchBodyFor("rust ownership", { type: "video", country: "si", language: "sl" })).toEqual({
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20260310.01.00",
        gl: "SI",
        hl: "sl",
      },
    },
    params: "EgIQAQ==",
    query: "rust ownership",
  });
});
