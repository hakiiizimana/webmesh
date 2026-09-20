const UNSAFE = [
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "link",
  "meta",
  "base",
  "title",
  "iframe",
  "object",
  "embed",
  "applet",
  "frame",
  "frameset",
  "canvas",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "fieldset",
  "legend",
  "button",
] as const;

// Preserve ambiguous content sections such as headers, asides, and widgets.
const NOISE = [
  "nav",
  ".navbar",
  "#nav",
  ".navigation",
  ".menu",
  ".breadcrumbs",
  "#breadcrumbs",
  ".ad",
  ".ads",
  ".advert",
  ".advertisement",
  "#ad",
  "#advertisement",
  "[class*='advert']",
  "[id*='advert']",
  ".cookie",
  "#cookie",
  "dialog",
  ".modal",
  ".popup",
  "#modal",
  ".overlay",
  ".share",
  "#share",
  ".social",
  ".social-media",
  ".social-links",
  "#social",
  "[hidden]",
] as const;

const REMOVE = [...UNSAFE, ...NOISE];

const URL_ATTRIBUTES = ["href", "src", "poster", "xlink:href", "data-src"] as const;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i;
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|file):/i;

function safeBase(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function absolute(value: string, base: string | null): string {
  if (!base) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function isDangerous(value: string, attribute: string): boolean {
  const url = value.trim().toLowerCase();
  if (DANGEROUS_SCHEME.test(url) || url.startsWith("data:text/html")) return true;
  if (!url.startsWith("data:")) return false;
  if (!(attribute === "src" || attribute === "poster" || attribute === "srcset")) return true;
  return !url.startsWith("data:image/");
}

type Source = { readonly url: string; readonly size: number; readonly isX: boolean };

function parseSource(part: string): Source | null {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const descriptor = tokens.at(-1) ?? "";
  const match = /^(\d+(?:\.\d+)?)([xw])$/i.exec(descriptor);
  const url = match ? tokens.slice(0, -1).join(" ") : tokens.join(" ");
  if (!url) return null;
  return { url, size: match ? Number(match[1]) : 1, isX: match ? match[2]?.toLowerCase() === "x" : true };
}

function biggestSource(srcset: string, src: string | null): string | null {
  const sources = srcset.split(",").flatMap((part) => parseSource(part) ?? []);
  if (sources.length === 0) return src;
  if (sources.every((source) => source.isX) && src) sources.push({ url: src, size: 1, isX: true });
  const best = sources.reduce((winner, source) => (source.size > winner.size ? source : winner));
  return best.url || src;
}

function sanitize(element: HTMLRewriterTypes.Element, base: string | null): void {
  const style = element.getAttribute("style");
  if (style && HIDDEN_STYLE.test(style)) {
    element.remove();
    return;
  }

  for (const [name, value] of Array.from(element.attributes)) {
    if (/^on/i.test(name)) {
      element.removeAttribute(name);
      continue;
    }
    if (name === "srcdoc") {
      element.removeAttribute(name);
      continue;
    }
    if (isDangerous(value, name)) {
      element.removeAttribute(name);
    }
  }

  for (const attribute of URL_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) element.setAttribute(attribute, absolute(value, base));
  }

  const srcset = element.getAttribute("srcset");
  if (srcset) {
    const src = element.getAttribute("src");
    const best = biggestSource(srcset, src);
    if (best) element.setAttribute("src", absolute(best, base));
  }
}

export async function cleanHtml(html: string, url: string): Promise<string> {
  const base = safeBase(url);
  const rewriter = new HTMLRewriter();
  for (const selector of REMOVE) {
    rewriter.on(selector, {
      element(element) {
        element.remove();
      },
    });
  }
  rewriter.on("*", {
    element(element) {
      sanitize(element, base);
    },
  });
  return rewriter.transform(new Response(html)).text();
}
