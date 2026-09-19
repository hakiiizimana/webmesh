import { z } from "zod";
import { request } from "../../../http";
import { blockedUrl } from "../../../network";
import type { YtDlpOptions } from "./index";
import { decodeYtDlpJson, type YtDlpJson } from "./parse";
import { DEFAULT_TIMEOUT_MS } from "./process";

const MAX_CAPTION_BYTES = 2_097_152;

type CaptionSource = { language: string; automatic: boolean; extension: string; url: string };

const nonEmpty = (text: string | undefined): string | null => text !== undefined && text.trim() !== "" ? text : null;

const captionSourcesFrom = (tracks: YtDlpJson["subtitles"], automatic: boolean): CaptionSource[] => {
  if (tracks === undefined) return [];
  return Object.entries(tracks).flatMap(([language, raw]) => raw.flatMap((format) => {
    if (format === undefined) return [];
    const url = nonEmpty(format.url);
    if (url === null || !/^https?:\/\//.test(url)) return [];
    return [{ language, automatic, extension: nonEmpty(format.ext) ?? "", url }];
  }));
};

const languageMatches = (actual: string, wanted: string): boolean => {
  const left = actual.toLowerCase().split("-")[0];
  const right = wanted.toLowerCase().split("-")[0];
  return left === right;
};

const chooseCaption = (value: YtDlpJson, language?: string): CaptionSource | undefined => {
  const sources = [...captionSourcesFrom(value.subtitles, false), ...captionSourcesFrom(value.automatic_captions, true)];
  const formatRank = (extension: string): number => ["vtt", "json3", "ttml", "srv3", "srv2", "srv1"].indexOf(extension);
  const languageRank = (source: CaptionSource): number => {
    const requested = language !== undefined && languageMatches(source.language, language);
    const english = languageMatches(source.language, "en");
    if (!source.automatic && requested) return 0;
    if (!source.automatic && english) return 1;
    if (!source.automatic) return 2;
    if (requested) return 3;
    if (english) return 4;
    return 5;
  };
  return sources.sort((left, right) => {
    const byLanguage = languageRank(left) - languageRank(right);
    if (byLanguage !== 0) return byLanguage;
    const leftFormat = formatRank(left.extension);
    const rightFormat = formatRank(right.extension);
    return (leftFormat < 0 ? 99 : leftFormat) - (rightFormat < 0 ? 99 : rightFormat);
  })[0];
};

const decodeEntities = (text: string): string => text
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'");

const cleanTranscriptLines = (lines: string[]): string | null => {
  const cleaned: string[] = [];
  for (const line of lines) {
    const text = decodeEntities(line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (text && text !== cleaned.at(-1)) cleaned.push(text);
  }
  return cleaned.length === 0 ? null : cleaned.join("\n\n");
};

const json3Segment = z.object({ utf8: z.string().optional().catch(undefined) });
const json3Event = z.object({
  segs: z.array(json3Segment.optional().catch(undefined)).optional().catch(undefined),
});
const json3Captions = z.object({
  events: z.array(json3Event.optional().catch(undefined)).optional().catch(undefined),
});

export function captionToMarkdown(body: string, extension: string): string | null {
  if (extension === "json3") {
    let decoded: z.infer<typeof json3Captions>;
    try {
      const parsed = json3Captions.safeParse(JSON.parse(body));
      if (!parsed.success) return null;
      decoded = parsed.data;
    } catch {
      return null;
    }
    const events = decoded.events;
    if (events === undefined) return null;
    return cleanTranscriptLines(events.flatMap((event) => {
      if (event === undefined || event.segs === undefined) return [];
      return [event.segs.map((segment) => segment?.utf8 ?? "").join("")];
    }));
  }
  const lines = body.split(/\r?\n/).filter((line) =>
    !/^WEBVTT|^Kind:|^Language:|^NOTE|^\d+$|^\s*$|-->/.test(line.trim()),
  );
  return cleanTranscriptLines(lines);
}

export async function transcriptFrom<T>(value: T, options: YtDlpOptions): Promise<string | null> {
  const json = decodeYtDlpJson(value);
  if (json === null) return null;
  const selected = chooseCaption(json, options.language);
  if (selected === undefined) return null;
  try {
    if (!options.allowPrivateNetworks && await blockedUrl(selected.url, options.resolve)) return null;
    const response = await request(selected.url, { signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS), proxy: options.proxy });
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CAPTION_BYTES) return null;
    return captionToMarkdown(body, selected.extension);
  } catch {
    return null;
  }
}
