import { inspectMp4 } from "./mp4.ts";
import { MAX_VIDEO_BYTES } from "./media.ts";
import type { ApiFailure, ParsedVideo } from "./types.ts";

export type ReceivedVideo = { blob: Blob; width: number; height: number; duration: number; bytes: number };
export type ReceiveProgress = { received: number; progress?: number; message: string };
type Listener = (progress: ReceiveProgress) => void;
type Pending = { promise: Promise<ReceivedVideo>; listeners: Set<Listener> };
const cache = new Map<string, ReceivedVideo>();
const pending = new Map<string, Pending>();
const pins = new Set<string>();
const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
let active = 0;
let paused = false;
let serviceBlock: ApiFailure | null = null;
const CACHE_BYTES = 512 * 1024 * 1024;

export class MediaRequestError extends Error {
  detail: ApiFailure;
  constructor(detail: ApiFailure) { super(detail.error); this.name = "MediaRequestError"; this.detail = detail; }
}

function drain() {
  while (!paused && !serviceBlock && active < 2 && waiting.length) { active++; waiting.shift()!.resolve(); }
}
async function acquire() {
  await new Promise<void>((resolve, reject) => {
    if (serviceBlock) { reject(new MediaRequestError(serviceBlock)); return; }
    waiting.push({ resolve, reject }); drain();
  });
}
function trimCache() {
  let bytes = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
  for (const [id, item] of cache) {
    if (bytes <= CACHE_BYTES) break;
    if (!pins.has(id)) { cache.delete(id); bytes -= item.bytes; }
  }
}
export function setTransfersPaused(value: boolean) { paused = value; drain(); }
/** Parser/media service failures stop queued uncached work; current transfers may finish. */
export function setMediaServiceBlocked(message: string | null) {
  serviceBlock = message ? { error: message, code: "MEDIA_SERVICE_BLOCKED", serviceBlocked: true } : null;
  if (serviceBlock) {
    const error = new MediaRequestError(serviceBlock);
    while (waiting.length) waiting.shift()!.reject(error);
  } else drain();
}
export function isMediaServiceBlocked(): boolean { return serviceBlock !== null; }
export function pinReceived(ids: string[]) { pins.clear(); ids.forEach(id => pins.add(id)); trimCache(); }
export function peekReceived(contentId: string): ReceivedVideo | undefined {
  const item = cache.get(contentId);
  if (item) { cache.delete(contentId); cache.set(contentId, item); }
  return item;
}
export function clearReceived() { for (const id of cache.keys()) if (!pins.has(id)) cache.delete(id); }

/** Sharing by work ID coalesces downloads and editing into at most two transfers. */
export async function receiveVideo(video: ParsedVideo, onProgress?: Listener): Promise<ReceivedVideo> {
  const cached = peekReceived(video.contentId);
  if (cached) return cached;
  if (serviceBlock) throw new MediaRequestError(serviceBlock);
  let request = pending.get(video.contentId);
  if (!request) {
    const listeners = new Set<Listener>();
    const promise = (async () => {
      let acquired = false;
      try {
        await acquire(); acquired = true;
        if (!video.mediaToken) throw new Error("视频地址已失效，请重新解析该作品。");
        const response = await fetch(`/api/media?token=${encodeURIComponent(video.mediaToken)}`, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as Partial<ApiFailure>;
          if (result.serviceBlocked) setMediaServiceBlocked(result.error || "媒体服务暂不可用，请稍后继续。");
          throw new MediaRequestError({ error: result.error || "视频接收失败，请重新解析。", code: result.code || "MEDIA_ERROR", serviceBlocked: result.serviceBlocked === true });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("浏览器无法接收视频文件。");
        const expected = Number(response.headers.get("content-length") || 0);
        if (expected > MAX_VIDEO_BYTES) { await reader.cancel(); throw new Error("视频超过 200 MB，已停止接收。"); }
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_VIDEO_BYTES) { await reader.cancel(); throw new Error("视频超过 200 MB，已停止接收。"); }
          chunks.push(value);
          const update = { received, progress: expected ? Math.min(99, Math.round(received / expected * 100)) : undefined, message: `已接收 ${(received / 1024 / 1024).toFixed(1)} MB` };
          listeners.forEach(listener => listener(update));
        }
        if (expected && received !== expected) throw new Error("视频传输不完整，请重新解析。");
        const blob = new Blob(chunks, { type: "video/mp4" });
        const info = inspectMp4(await blob.arrayBuffer(), video.bytes || undefined);
        const result = { blob, width: info.width, height: info.height, duration: info.duration, bytes: received };
        cache.set(video.contentId, result); trimCache();
        return result;
      } finally { if (acquired) active--; pending.delete(video.contentId); drain(); }
    })();
    request = { promise, listeners }; pending.set(video.contentId, request);
  }
  if (onProgress) request.listeners.add(onProgress);
  try { return await request.promise; } finally { if (onProgress) request.listeners.delete(onProgress); }
}
