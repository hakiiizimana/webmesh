import { request } from "../../../http";
import type { SearchContext, SearchFilters, SearchItem } from "../../types";
import type { Custom } from "../../types";
import { isFreshnessRange, onlyFilters } from "../shared";
import { INNERTUBE_URL, youtubeSearchBodyFor } from "./params";
import { parseYoutubeSearchResponse } from "./parse";

export const searchYoutube = async (query: string, context: SearchContext): Promise<SearchItem[]> => {
  const response = await request(INNERTUBE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.youtube.com",
    },
    body: JSON.stringify(youtubeSearchBodyFor(query, context.filters)),
    signal: context.signal,
    proxy: context.proxy,
  });
  return parseYoutubeSearchResponse(await response.text()).slice(0, context.limit);
};

function youtubeSupports(filters: SearchFilters): boolean {
  return (
    filters.type === "video" &&
    onlyFilters("freshness", "type", "country", "language")(filters) &&
    (filters.country === undefined || /^[a-z]{2}$/i.test(filters.country)) &&
    (filters.freshness === undefined || !isFreshnessRange(filters.freshness))
  );
}

export const youtube = {
  kind: "scrape",
  search: searchYoutube,
  supports: youtubeSupports,
} satisfies Custom;
