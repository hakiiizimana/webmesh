import type { Json } from "../../../http";
import type { SearchFilters } from "../../types";

// Public WEB client values shipped by YouTube itself; they are not account credentials.
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const WEB_CLIENT_VERSION = "2.20260310.01.00";
export const INNERTUBE_URL =
  `https://www.youtube.com/youtubei/v1/search?key=${encodeURIComponent(INNERTUBE_API_KEY)}&prettyPrint=false`;

const appendVarint = (bytes: number[], value: number): void => {
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining === 0 ? byte : byte | 0x80);
  } while (remaining !== 0);
};

const appendField = (bytes: number[], field: number, value: number): void => {
  appendVarint(bytes, field << 3);
  appendVarint(bytes, value);
};

const uploadDateValue = (freshness: SearchFilters["freshness"]): number => {
  switch (freshness) {
    case "day":
      return 2;
    case "week":
      return 3;
    case "month":
      return 4;
    case "year":
      return 5;
    default:
      return 0;
  }
};

export const youtubeSearchParamsFor = (filters: SearchFilters): string => {
  const filterBytes: number[] = [];
  const uploadDate = uploadDateValue(filters.freshness);
  if (uploadDate !== 0) appendField(filterBytes, 1, uploadDate);
  appendField(filterBytes, 2, 1);

  const params: number[] = [];
  appendVarint(params, (2 << 3) | 2);
  appendVarint(params, filterBytes.length);
  params.push(...filterBytes);
  return Buffer.from(params).toString("base64");
};

const youtubeContextFor = (filters: SearchFilters) => ({
  client: {
    clientName: "WEB",
    clientVersion: WEB_CLIENT_VERSION,
    gl: filters.country?.toUpperCase() ?? "US",
    hl: filters.language ?? "en",
  },
});

export const youtubeSearchBodyFor = (query: string, filters: SearchFilters): Json => ({
  context: youtubeContextFor(filters),
  params: youtubeSearchParamsFor(filters),
  query,
});
