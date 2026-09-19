import type { SearchItem } from "../../types";

type YoutubeJsonValue = YoutubeJsonObject | YoutubeJsonValue[] | boolean | null | number | string;

interface YoutubeJsonObject {
  readonly [key: string]: YoutubeJsonValue;
}

const isObject = (value: YoutubeJsonValue | undefined): value is YoutubeJsonObject =>
  value instanceof Object && !Array.isArray(value);

const isString = (value: YoutubeJsonValue | undefined): value is string => value === String(value);

const objectAt = (value: YoutubeJsonObject | null, key: string): YoutubeJsonObject | null => {
  const child = value?.[key];
  return isObject(child) ? child : null;
};

const trimmedStringAt = (value: YoutubeJsonObject | null, key: string): string | null => {
  const child = value?.[key];
  return isString(child) && child.trim() !== "" ? child.trim() : null;
};

const stringAt = (value: YoutubeJsonObject | null, key: string): string | null => {
  const child = value?.[key];
  return isString(child) ? child : null;
};

const jsonObjectFrom = (body: string): YoutubeJsonObject | null => {
  let parsed: YoutubeJsonValue;
  try {
    // SAFETY: the parsed value is only read through the guards in this module.
    parsed = JSON.parse(body) as YoutubeJsonValue;
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
};

const textFrom = (value: YoutubeJsonValue | undefined): string | undefined => {
  if (isString(value)) return value.trim() || undefined;
  if (!isObject(value)) return undefined;
  const direct = trimmedStringAt(value, "simpleText") ?? trimmedStringAt(value, "content");
  if (direct !== null) return direct;
  if (!Array.isArray(value.runs)) return undefined;
  const text = value.runs
    .filter(isObject)
    .map((run) => stringAt(run, "text") ?? stringAt(run, "content") ?? "")
    .join("")
    .trim();
  return text || undefined;
};

const textAt = (value: YoutubeJsonObject | null, key: string): string | undefined => textFrom(value?.[key]);

const findString = (value: YoutubeJsonValue | undefined, key: string): string | undefined => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findString(child, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const direct = trimmedStringAt(value, key);
  if (direct !== null) return direct;
  for (const child of Object.values(value)) {
    const found = findString(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

const textFromFirst = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => value !== undefined && value.length > 0);

const detailedDescriptionAt = (value: YoutubeJsonObject | null): string | undefined => {
  const snippets = value?.detailedMetadataSnippets;
  if (!Array.isArray(snippets)) return undefined;
  const text = snippets
    .filter(isObject)
    .map((snippet) => textFrom(snippet.snippetText))
    .filter((description): description is string => description !== undefined)
    .join("\n")
    .trim();
  return text || undefined;
};

const descriptionFrom = (...renderers: Array<YoutubeJsonObject | null>): string =>
  renderers
    .flatMap((renderer) =>
      renderer === null
        ? []
        : [
            textAt(renderer, "descriptionSnippet"),
            textAt(renderer, "description"),
            detailedDescriptionAt(renderer),
          ],
    )
    .filter((description): description is string => description !== undefined)
    .filter((description, index, descriptions) => descriptions.indexOf(description) === index)
    .join("\n");

const DURATION_PATTERN = /^\d{1,3}(?::\d{2}){1,2}$/u;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{4,}$/u;
const COUNT_MULTIPLIERS = {
  b: 1_000_000_000,
  k: 1_000,
  m: 1_000_000,
  md: 1_000_000_000,
  mil: 1_000,
  mio: 1_000_000,
  mrd: 1_000_000_000,
  tsd: 1_000,
} as const;
type CountSuffix = keyof typeof COUNT_MULTIPLIERS;

const isCountSuffix = (value: string | undefined): value is CountSuffix =>
  value !== undefined && value in COUNT_MULTIPLIERS;

const amountFromText = (value: string, hasSuffix: boolean): number => {
  const compact = value.replace(/[\s\u00a0\u202f]/gu, "");
  const groups = compact.split(/[.,]/u);
  const grouped = groups.length > 1 && groups.slice(1).every((group) => group.length === 3);
  if (grouped) return Number(groups.join(""));
  if (groups.length === 1) return Number(compact);

  const separator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  const fraction = compact.slice(separator + 1);
  if (hasSuffix && fraction.length > 2) return Number(compact.replace(/[.,]/gu, ""));
  const whole = compact.slice(0, separator).replace(/[.,]/gu, "");
  return Number(`${whole}.${fraction}`);
};

const viewCountFromText = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  if (/^no\s+(views?|subscribers?|videos?)$/iu.test(value.trim())) return 0;
  const match = /([0-9][0-9.,\s\u00a0\u202f]*)(?:\s*(mrd|mio|mil|md|tsd|b|k|m)\.?)?/iu.exec(value);
  if (match === null) return null;
  const amount = amountFromText(match[1] ?? "", match[2] !== undefined);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const suffix = match[2]?.toLowerCase();
  const scaled = Math.round(amount * (isCountSuffix(suffix) ? COUNT_MULTIPLIERS[suffix] : 1));
  return Number.isSafeInteger(scaled) ? scaled : null;
};

const secondsFromText = (value: string | undefined): number | null => {
  if (value === undefined || !DURATION_PATTERN.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
};

const VIDEO_LOCKUP_TYPES = new Set([
  "LOCKUP_CONTENT_TYPE_VIDEO",
  "LOCKUP_CONTENT_TYPE_SHORT",
  "LOCKUP_CONTENT_TYPE_MOVIE",
]);

const youtubeVideoUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

const youtubeChannelUrl = (id: string): string => `https://www.youtube.com/channel/${encodeURIComponent(id)}`;

const channelUrlFrom = (value: YoutubeJsonValue | undefined): string | null => {
  const id = findString(value, "browseId");
  if (id !== undefined && CHANNEL_ID_PATTERN.test(id)) return youtubeChannelUrl(id);
  const canonical = findString(value, "canonicalBaseUrl");
  if (canonical?.startsWith("/@") === true) return `https://www.youtube.com${canonical}`;
  return null;
};

type MetadataPart = { text: string; node: YoutubeJsonObject };

const metadataPartsFrom = (lockup: YoutubeJsonObject | null): MetadataPart[] => {
  const metadata = objectAt(objectAt(lockup, "metadata"), "lockupMetadataViewModel");
  const rows = objectAt(objectAt(metadata, "metadata"), "contentMetadataViewModel")?.metadataRows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!isObject(row) || !Array.isArray(row.metadataParts)) return [];
    return row.metadataParts.flatMap((part) => {
      if (!isObject(part)) return [];
      const text = textAt(part, "text");
      return text === undefined ? [] : [{ node: part, text }];
    });
  });
};

const badgeTextsFrom = (value: YoutubeJsonValue | undefined): string[] => {
  const texts: string[] = [];
  const visit = (current: YoutubeJsonValue | undefined): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isObject(current)) return;
    const badge = textAt(objectAt(current, "thumbnailBadgeViewModel"), "text");
    if (badge !== undefined) texts.push(badge);
    Object.values(current).forEach(visit);
  };
  visit(value);
  return texts;
};

const videoMetadataFrom = (
  legacy: YoutubeJsonObject | null,
  lockup: YoutubeJsonObject | null,
): Pick<SearchItem, "durationSeconds" | "channelUrl" | "viewCount"> => {
  const metadataParts = metadataPartsFrom(lockup);
  const viewText = textFromFirst(
    textAt(legacy, "viewCountText"),
    textAt(legacy, "shortViewCountText"),
    metadataParts.find((part) => /\b(views?|watching)\b/iu.test(part.text))?.text,
  );
  const durationText = textFromFirst(
    textAt(legacy, "lengthText"),
    ...badgeTextsFrom(objectAt(lockup, "contentImage")).filter((text) => DURATION_PATTERN.test(text)),
  );
  const owner = objectAt(legacy, "ownerText") ?? objectAt(legacy, "shortBylineText");
  const ownerPart = metadataParts.find((part) => findString(part.node, "browseId") !== undefined);

  return {
    durationSeconds: secondsFromText(durationText),
    channelUrl: channelUrlFrom(owner ?? ownerPart?.node),
    viewCount: viewCountFromText(viewText),
  };
};

const videoFromShort = (renderer: YoutubeJsonObject): SearchItem | null => {
  const entityId = trimmedStringAt(renderer, "entityId");
  const id =
    findString(renderer.onTap, "videoId") ??
    (entityId?.startsWith("shorts-shelf-item-") === true
      ? entityId.slice("shorts-shelf-item-".length)
      : undefined);
  const overlay = objectAt(renderer, "overlayMetadata");
  const title = textFromFirst(textAt(overlay, "primaryText"), textAt(renderer, "title"));
  if (id === undefined || id === "" || title === undefined) return null;
  return {
    title,
    url: youtubeVideoUrl(id),
    description: descriptionFrom(renderer),
    durationSeconds: null,
    channelUrl: channelUrlFrom(renderer),
    viewCount: viewCountFromText(textAt(overlay, "secondaryText")),
  };
};

const videoFromItem = (item: YoutubeJsonObject): SearchItem | null => {
  const short = objectAt(item, "shortsLockupViewModel");
  if (short !== null) return videoFromShort(short);

  const lockup = objectAt(item, "lockupViewModel");
  const contentType = trimmedStringAt(lockup, "contentType");
  if (contentType !== null && !VIDEO_LOCKUP_TYPES.has(contentType)) return null;

  const legacy = objectAt(item, "videoRenderer") ?? objectAt(item, "movieRenderer");
  if (legacy === null && lockup === null) return null;

  const metadata = objectAt(objectAt(lockup, "metadata"), "lockupMetadataViewModel");
  const id =
    trimmedStringAt(legacy, "videoId") ??
    trimmedStringAt(legacy, "movieId") ??
    trimmedStringAt(lockup, "contentId");
  const title = textFromFirst(textAt(legacy, "title"), textAt(metadata, "title"), textAt(lockup, "title"));
  if (id === null || title === undefined) return null;

  return {
    title,
    url: youtubeVideoUrl(id),
    description: descriptionFrom(legacy, lockup),
    ...videoMetadataFrom(legacy, lockup),
  };
};

const RENDERER_KEYS = ["videoRenderer", "movieRenderer", "lockupViewModel", "shortsLockupViewModel"] as const;

const collectVideoItems = (value: YoutubeJsonValue, items: YoutubeJsonObject[]): void => {
  if (Array.isArray(value)) {
    for (const child of value) collectVideoItems(child, items);
    return;
  }
  if (!isObject(value)) return;
  if (RENDERER_KEYS.some((key) => objectAt(value, key) !== null)) items.push(value);
  for (const child of Object.values(value)) collectVideoItems(child, items);
};

export const parseYoutubeSearchResponse = (body: string): SearchItem[] => {
  const root = jsonObjectFrom(body);
  if (root === null) throw new Error("YouTube InnerTube response was not JSON");

  const items: YoutubeJsonObject[] = [];
  collectVideoItems(root, items);
  const seen = new Set<string>();
  const results: SearchItem[] = [];
  for (const item of items) {
    const result = videoFromItem(item);
    if (result === null || seen.has(result.url)) continue;
    seen.add(result.url);
    results.push(result);
  }
  return results;
};
