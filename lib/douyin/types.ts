export type VideoInfo = {
  contentId: string;
  title: string;
  author: string;
  width: number;
  height: number;
  duration: number;
  bytes: number;
  watermark: boolean | null;
};

export type ParsedVideo = VideoInfo & { mediaToken: string };
export type ParseResponse = { status: "ready"; video: ParsedVideo } | { status: "pending"; taskToken: string };
export type ApiFailure = { error: string; code: string; serviceBlocked: boolean; retryAfter?: number };
export type JobStatus = "queued" | "parsing" | "ready" | "downloading" | "verified" | "failed" | "stale" | "duplicate";
export type Job = {
  id: string;
  url: string;
  status: JobStatus;
  addedAt: number;
  video?: ParsedVideo;
  message?: string;
  progress?: number;
};
