import { ServiceError } from "./errors.ts";

const SUFFIXES = ["douyinvod.com", "douyin.com", "bytecdn.cn", "byteimg.com", "byteimg.cn", "pstatp.com", "bytedance.com", "ibytedtos.com", "bytevcloudcdn.com", "amemv.com", "snssdk.com", "zijieapi.com", "zjcdn.com"];
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function isMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 5000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && SUFFIXES.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch { return false; }
}

export async function fetchMedia(url: string, requestFetch: typeof fetch = fetch): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!isMediaUrl(current)) throw new ServiceError("媒体地址不在支持的视频域名范围内。", "UNSUPPORTED_MEDIA_HOST", 422);
    const response = await requestFetch(current, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.douyin.com/" },
      redirect: "manual", signal: AbortSignal.timeout(40_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) break;
    current = new URL(location, current).href;
  }
  throw new ServiceError("媒体跳转次数过多，请重新解析。", "MEDIA_REDIRECT", 502);
}
