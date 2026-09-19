import { TargetError } from "../../router";
import type { FetchedPage, FetchContext } from "../types";
import { extractYtDlpMetadata } from "./ytDlp";

const SOCIAL_HOSTS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|reddit\.com|redd\.it|facebook\.com|fb\.watch|vimeo\.com|twitch\.tv|soundcloud\.com)$/i;

export const acceptsSocialUrl = (url: string): boolean => {
  const parsed = URL.parse(url);
  return parsed !== null && SOCIAL_HOSTS.test(parsed.hostname);
};

export async function fetchSocial(url: string, { signal, proxy, allowPrivateNetworks, resolve }: FetchContext): Promise<FetchedPage> {
  const result = await extractYtDlpMetadata(url, { signal, proxy, allowPrivateNetworks, resolve });
  if (!result.success) throw new TargetError(result.error.message);
  const media = result.data;
  const content = media.transcript?.trim() || media.description.trim() || media.title;
  const page: FetchedPage = { url: media.url, title: media.title, content, media };
  if (media.publishedAt !== null) page.publishedAt = media.publishedAt;
  return page;
}
