import { z } from "zod";
import { createBrowser } from "../../browser";
import type { FetchedPage, FetchContext } from "../types";
import { MIN_WORDS, assertPageStatus } from "./page";

const openedPage = z.object({ title: z.string().optional(), url: z.string().optional() });
const readPage = z.object({ content: z.string(), status: z.number().nullish() });

export async function fetchInBrowser(url: string, { signal, proxy, allowPrivateNetworks, allowPrivateHosts }: FetchContext): Promise<FetchedPage> {
  const browser = createBrowser(`webmesh-fetch-${crypto.randomUUID().slice(0, 8)}`, { proxy, allowPrivateNetworks, allowPrivateHosts });
  try {
    const opened = await browser.run(["open", url], signal);
    if (!opened.success) throw new Error(opened.error);
    const read = await browser.run(["read"], signal);
    if (!read.success) throw new Error(read.error);
    const page = readPage.parse(read.data);
    assertPageStatus(page.status);
    if (page.content.split(/\s+/).length < MIN_WORDS) throw new Error("too little content after rendering");
    const meta = openedPage.parse(opened.data);
    return { url: meta.url ?? url, title: meta.title || url, content: page.content };
  } finally {
    await browser.close();
  }
}
