export const LINK_LIMIT = 50;
const HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"]);

export function decodeShareText(input: string): string {
  return input
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_, value: string) => {
      const code = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/\\([:/?&=_.()\[\]#-])/g, "$1");
}

export function normalizeLink(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/[.,;!?，。；！？”’）】》]+$/u, ""));
    if (!HOSTS.has(url.hostname) || url.username || url.password || url.port || !["https:", "http:"].includes(url.protocol)) return null;
    const video = url.pathname.match(/^\/(?:share\/)?video\/(\d+)\/?$/);
    if (video && url.hostname !== "v.douyin.com") return `https://www.douyin.com/video/${video[1]}`;
    const modal = url.searchParams.get("modal_id");
    if (["douyin.com", "www.douyin.com"].includes(url.hostname) && modal && /^\d+$/.test(modal)) return `https://www.douyin.com/video/${modal}`;
    if (url.hostname === "v.douyin.com" && /^\/[\w-]+\/?$/.test(url.pathname)) return `https://v.douyin.com${url.pathname.replace(/\/?$/, "/")}`;
  } catch { /* Untrusted input is deliberately ignored. */ }
  return null;
}

export function extractLinks(input: string): { links: string[]; duplicates: number; overflow: number } {
  const text = decodeShareText(input);
  // Strip Markdown labels so that only a link's actual destination is considered.
  const destinations = text.replace(/\[[^\]\n]*\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)/g, "$1");
  const matches = destinations.match(/https?:\/\/[^\s<>"'，。；、）】》)\]]+/g) ?? [];
  const unique = new Set<string>();
  let duplicates = 0;
  for (const raw of matches) {
    const link = normalizeLink(raw);
    if (!link) continue;
    if (unique.has(link)) duplicates++;
    else unique.add(link);
  }
  return { links: [...unique].slice(0, LINK_LIMIT), duplicates, overflow: Math.max(0, unique.size - LINK_LIMIT) };
}

export function requestedId(url: string): string | null {
  return url.match(/^https:\/\/www\.douyin\.com\/video\/(\d+)$/)?.[1] ?? null;
}
