import { z } from "zod";
import type { Json } from "../http";
import { page } from "./types";

const CACHE_TTL_MS = 20 * 60_000;

export const cachedFetch = z.object({
  success: z.literal(true),
  data: page,
});

export const cacheTtl = () => CACHE_TTL_MS;

export function cacheKey(
  url: string,
  formats: readonly string[],
  schema: Json | undefined,
  maxCharacters: number,
  only: readonly string[] | undefined,
): string {
  return JSON.stringify({
    version: 1,
    url,
    formats: [...formats].sort(),
    schema,
    maxCharacters,
    only: only?.length ? [...only].sort() : undefined,
  });
}
