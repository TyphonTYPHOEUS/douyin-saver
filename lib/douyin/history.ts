import { normalizeLink } from "./links.ts";
import type { Job, JobStatus } from "./types.ts";

export const HISTORY_KEY = "douyin-saver.history.v1";
export const HISTORY_LIMIT = 200;

export function serializeHistory(jobs: Job[]): string {
  return JSON.stringify(jobs.slice(-HISTORY_LIMIT).map(job => ({
    ...job, progress: undefined,
    video: job.video ? { ...job.video, mediaToken: undefined } : undefined,
  })));
}

export function restoreHistory(raw: string | null): Job[] {
  if (!raw) return [];
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows.slice(-HISTORY_LIMIT).flatMap((value): Job[] => {
      if (!value || typeof value !== "object" || typeof value.url !== "string" || !normalizeLink(value.url) || typeof value.id !== "string" || !Number.isFinite(value.addedAt)) return [];
      const status: JobStatus = value.status === "verified" ? "verified" : value.status === "failed" ? "failed" : value.status === "duplicate" ? "duplicate" : "stale";
      const saved = value.video;
      const video = saved && /^\d{1,32}$/.test(String(saved.contentId)) && typeof saved.title === "string" ? {
        contentId: String(saved.contentId), title: saved.title.slice(0, 500), author: typeof saved.author === "string" ? saved.author.slice(0, 100) : "抖音创作者",
        width: Number(saved.width) || 0, height: Number(saved.height) || 0, duration: Number(saved.duration) || 0, bytes: Number(saved.bytes) || 0,
        watermark: typeof saved.watermark === "boolean" ? saved.watermark : null, mediaToken: "",
      } : undefined;
      return [{ id: value.id, url: normalizeLink(value.url)!, addedAt: value.addedAt, status, video, message: status === "stale" ? "重新解析后可继续保存" : typeof value.message === "string" ? value.message.slice(0, 300) : undefined }];
    });
  } catch { return []; }
}
