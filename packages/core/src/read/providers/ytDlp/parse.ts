import { z } from "zod";
import type { YtDlpMetadata } from "./index";

const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().finite().nonnegative().optional().catch(undefined);

const captionFormat = z.object({
  ext: optionalString,
  name: optionalString,
  protocol: optionalString,
  url: optionalString,
});

const chapter = z.object({
  title: optionalString,
  start_time: optionalNumber,
  end_time: optionalNumber,
});

const captionTracks = z
  .record(z.string(), z.array(captionFormat.optional().catch(undefined)).catch([]))
  .optional()
  .catch(undefined);

/** Permissive decode of yt-dlp's `--dump-single-json` payload; unknown platform fields are preserved. */
const ytDlpJsonSchema = z.object({
  id: optionalString,
  title: optionalString,
  fulltitle: optionalString,
  _type: optionalString,
  vcodec: optionalString,
  acodec: optionalString,
  duration: optionalNumber,
  thumbnail: optionalString,
  description: optionalString,
  webpage_url: optionalString,
  original_url: optionalString,
  webpage_url_domain: optionalString,
  extractor_key: optionalString,
  extractor: optionalString,
  uploader: optionalString,
  channel: optionalString,
  creator: optionalString,
  artist: optionalString,
  uploader_id: optionalString,
  channel_id: optionalString,
  creator_id: optionalString,
  artist_id: optionalString,
  uploader_url: optionalString,
  channel_url: optionalString,
  creator_url: optionalString,
  upload_date: optionalString,
  release_date: optionalString,
  timestamp: optionalString,
  view_count: optionalNumber,
  like_count: optionalNumber,
  comment_count: optionalNumber,
  repost_count: optionalNumber,
  tags: z.array(optionalString).optional().catch(undefined),
  categories: z.array(optionalString).optional().catch(undefined),
  chapters: z.array(chapter.optional().catch(undefined)).optional().catch(undefined),
  subtitles: captionTracks,
  automatic_captions: captionTracks,
  live_status: optionalString,
  availability: optionalString,
  age_limit: optionalNumber,
});

/** Parser that preserves untyped extra fields at runtime. */
const ytDlpJsonParser = ytDlpJsonSchema.passthrough();

export type YtDlpJson = z.infer<typeof ytDlpJsonSchema>;

/** Decode raw external JSON at its boundary; returns null when the payload is not a yt-dlp object. */
export const decodeYtDlpJson = <T>(value: T): YtDlpJson | null => {
  const decoded = ytDlpJsonParser.safeParse(value);
  return decoded.success ? decoded.data : null;
};

export const isObject = <T>(value: T): boolean => value instanceof Object && !Array.isArray(value);

type StringField = { [K in keyof YtDlpJson]-?: YtDlpJson[K] extends string | undefined ? K : never }[keyof YtDlpJson];
type NumberField = { [K in keyof YtDlpJson]-?: YtDlpJson[K] extends number | undefined ? K : never }[keyof YtDlpJson];

const nonEmpty = (text: string | undefined): string | null => text !== undefined && text.trim() !== "" ? text : null;

export const stringAt = (value: YtDlpJson, ...keys: readonly StringField[]): string | null => {
  for (const key of keys) {
    const result = value[key];
    if (result !== undefined && result.trim() !== "") return result;
  }
  return null;
};

const numberAt = (value: YtDlpJson, ...keys: readonly NumberField[]): number | null => {
  for (const key of keys) {
    const result = value[key];
    if (result !== undefined) return result;
  }
  return null;
};

const stringsAt = (value: YtDlpJson, key: "tags" | "categories"): string[] => {
  const items = value[key];
  return items === undefined ? [] : items.filter((item): item is string => item !== undefined && item.trim() !== "");
};

const dateFrom = (value: string | null): string | null => {
  if (value === null) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
};

const mediaTypeFrom = (value: YtDlpJson): YtDlpMetadata["mediaType"] => {
  const type = stringAt(value, "_type");
  if (type === "playlist" || type === "multi_video") return "playlist";
  const video = stringAt(value, "vcodec");
  const audio = stringAt(value, "acodec");
  if (video === "none" && audio !== null && audio !== "none") return "audio";
  if (numberAt(value, "duration") !== null || video !== null) return "video";
  return stringAt(value, "thumbnail") === null ? "unknown" : "image";
};

const chaptersFrom = (value: YtDlpJson): YtDlpMetadata["chapters"] => {
  const chapters = value.chapters;
  if (chapters === undefined) return [];
  return chapters.flatMap((chapter) => {
    if (chapter === undefined) return [];
    const title = chapter.title;
    const startSeconds = chapter.start_time;
    if (title === undefined || title.trim() === "" || startSeconds === undefined) return [];
    return [{ title, startSeconds, endSeconds: chapter.end_time ?? null }];
  });
};

const captionsFrom = (value: YtDlpJson, automatic: boolean): YtDlpMetadata["captions"][number][] => {
  const tracks = automatic ? value.automatic_captions : value.subtitles;
  if (tracks === undefined) return [];
  return Object.entries(tracks).flatMap(([language, raw]) => {
    const objects = raw.filter((format) => format !== undefined);
    const formats = objects.map((format) => ({
      extension: nonEmpty(format.ext),
      name: nonEmpty(format.name),
      protocol: nonEmpty(format.protocol),
    }));
    if (formats.length === 0) return [];
    return [{ language, name: nonEmpty(objects[0]?.name), automatic, formats }];
  });
};

export const metadataFrom = <T>(value: T, sourceUrl: string, transcript: string | null): YtDlpMetadata | null => {
  const json = decodeYtDlpJson(value);
  if (json === null) return null;
  const id = stringAt(json, "id");
  const title = stringAt(json, "title", "fulltitle");
  if (id === null || title === null) return null;
  const extractor = stringAt(json, "extractor_key", "extractor") ?? "unknown";
  return {
    id,
    site: stringAt(json, "webpage_url_domain") ?? extractor.toLowerCase(),
    extractor,
    mediaType: mediaTypeFrom(json),
    title,
    description: stringAt(json, "description") ?? "",
    url: stringAt(json, "webpage_url", "original_url") ?? sourceUrl,
    creator: stringAt(json, "uploader", "channel", "creator", "artist"),
    creatorId: stringAt(json, "uploader_id", "channel_id", "creator_id", "artist_id"),
    creatorUrl: stringAt(json, "uploader_url", "channel_url", "creator_url"),
    publishedAt: dateFrom(stringAt(json, "upload_date", "release_date", "timestamp")),
    durationSeconds: numberAt(json, "duration"),
    thumbnail: stringAt(json, "thumbnail"),
    engagement: {
      views: numberAt(json, "view_count"),
      likes: numberAt(json, "like_count"),
      comments: numberAt(json, "comment_count"),
      reposts: numberAt(json, "repost_count"),
    },
    tags: stringsAt(json, "tags"),
    categories: stringsAt(json, "categories"),
    chapters: chaptersFrom(json),
    captions: [...captionsFrom(json, false), ...captionsFrom(json, true)],
    transcript,
    liveStatus: stringAt(json, "live_status"),
    availability: stringAt(json, "availability"),
    ageLimit: numberAt(json, "age_limit"),
  };
};
