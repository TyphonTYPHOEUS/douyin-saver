import { ServiceError } from "./errors.ts";

const buckets = new Map<string, { count: number; expiresAt: number }>();
export function guard(request: Request, category: "parse" | "poll" | "media"): void {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ServiceError("请从本站发起请求。", "CROSS_ORIGIN", 403);
  }
  const identity = request.headers.get("cf-connecting-ip") || "local";
  const now = Date.now(), key = `${category}:${identity}`;
  if (buckets.size > 4000) {
    for (const [item, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(item);
    if (buckets.size > 4000) throw new ServiceError("网站繁忙，请稍后再试。", "SITE_BUSY", 429, true, 60);
  }
  const bucket = buckets.get(key);
  const limit = category === "poll" ? 90 : category === "media" ? 12 : 12;
  if (bucket && bucket.expiresAt > now) {
    if (bucket.count >= limit) throw new ServiceError("请求较多，队列已暂停，请一分钟后继续。", "RATE_LIMITED", 429, true, Math.ceil((bucket.expiresAt - now) / 1000));
    bucket.count++;
  } else buckets.set(key, { count: 1, expiresAt: now + 60_000 });
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ServiceError("请求格式应为 JSON。", "INVALID_BODY", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError("请求内容为空。", "INVALID_BODY", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24_000) { await reader.cancel(); throw new ServiceError("请求内容过长。", "BODY_TOO_LARGE", 413); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || Array.isArray(result) || typeof result !== "object") throw new Error();
    return result;
  } catch { throw new ServiceError("请求内容无法识别。", "INVALID_BODY", 400); }
}
