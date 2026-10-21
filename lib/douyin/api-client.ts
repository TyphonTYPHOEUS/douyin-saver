import { ServiceError } from "./errors.ts";
import { normalizeLink, requestedId } from "./links.ts";
import { isMediaUrl, MAX_VIDEO_BYTES } from "./media.ts";
import { signToken } from "./tokens.ts";
import type { ParseResponse } from "./types.ts";

export type ApiConfig = { apiBase: string; apiKey: string; tokenSecret: string };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
let demoSession: { base: string; cookie: string; expiresAt: number } | null = null;
let loginPromise: Promise<string> | null = null;

async function requestJson(config: ApiConfig, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ data: ObjectValue; response: Response }> {
  let response: Response;
  try {
    response = await fetch(config.apiBase + path, {
      method: body === undefined ? "GET" : "POST", redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(29_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    console.warn("DTK network request failed", error instanceof Error ? `${error.name}: ${error.message}` : "network error");
    throw new ServiceError(timedOut ? "连接解析服务超时，队列已暂停，请稍后继续。" : "暂时无法连接解析服务，队列已暂停，请稍后继续。", timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", 503, true);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ServiceError("解析服务返回了未预期的跳转，请联系部署者检查服务地址。", "UPSTREAM_REDIRECT", 502, true);
  }
  let envelope: ObjectValue;
  try { envelope = object(await response.json()); }
  catch { throw new ServiceError(`解析服务返回了非预期内容（HTTP ${response.status}）。`, "UPSTREAM_INVALID", 502, true); }
  if (!response.ok || envelope.success !== true) {
    const error = object(envelope.error);
    const code = typeof error.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(error.code) ? error.code : "UPSTREAM_ERROR";
    const blocked = [401, 403, 429, 500, 502, 503, 504].includes(response.status) || /BLOCKED|IDENTITY|UNAVAILABLE|RATE_LIMIT|TIMEOUT/.test(code);
    if (response.status === 401) demoSession = null;
    const message = response.status === 429 ? "公共解析服务限流，队列已暂停，请稍后继续。" : response.status === 401 || response.status === 403 ? "解析服务认证暂不可用，队列已暂停。" : response.status === 404 ? "该作品不存在、已删除或暂不可访问。" : `解析服务无法完成请求（${code}，HTTP ${response.status}）。`;
    throw new ServiceError(message, code, response.status >= 400 && response.status <= 599 ? response.status : 502, blocked, positive(error.retry_after) || undefined);
  }
  return { data: object(envelope.data), response };
}

async function authHeaders(config: ApiConfig): Promise<Record<string, string>> {
  if (!/^https:\/\//.test(config.apiBase)) throw new ServiceError("部署者需要配置 HTTPS 解析服务地址。", "INVALID_API_BASE", 503, true);
  if (config.tokenSecret.length < 32) throw new ServiceError("网站尚未配置下载签名密钥，请联系部署者。", "MISSING_SECRET", 503, true);
  if (config.apiKey) return { "X-API-Key": config.apiKey };
  if (config.apiBase !== "https://demo.douyin.wtf") throw new ServiceError("自托管解析服务需要配置 DTK_API_KEY。", "MISSING_API_KEY", 503, true);
  if (demoSession?.base === config.apiBase && demoSession.expiresAt > Date.now()) return { Cookie: demoSession.cookie };
  if (!loginPromise) {
    loginPromise = (async () => {
      const { data: credentials } = await requestJson(config, "/api/v1/auth/demo");
      if (typeof credentials.password !== "string" || !credentials.password) throw new ServiceError("公共演示会话暂不可用。", "DEMO_UNAVAILABLE", 503, true);
      const { response } = await requestJson(config, "/api/v1/auth/login", {}, { username: credentials.username || "demo", password: credentials.password });
      const cookies = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=)/);
      const cookie = cookies.map(value => value.split(";")[0].trim()).filter(Boolean).join("; ");
      if (!cookie) throw new ServiceError("解析服务没有提供临时会话。", "DEMO_UNAVAILABLE", 503, true);
      demoSession = { base: config.apiBase, cookie, expiresAt: Date.now() + 10 * 60_000 };
      return cookie;
    })();
  }
  try { return { Cookie: await loginPromise }; }
  finally { loginPromise = null; }
}

export async function shapeVideo(data: ObjectValue, source: string, config: ApiConfig): Promise<ParseResponse> {
  if (data.platform !== "douyin" || data.kind !== "video") throw new ServiceError("当前只支持抖音视频，暂不支持图集或其他平台。", "NOT_VIDEO", 422);
  if (data.is_private || data.is_deleted) throw new ServiceError("该作品为私密作品或已经删除。", "VIDEO_UNAVAILABLE", 404);
  const contentId = String(data.content_id ?? "");
  const expectedId = requestedId(source);
  if (!/^\d{1,32}$/.test(contentId) || (expectedId && contentId !== expectedId)) throw new ServiceError("返回的作品与请求不一致，已停止处理。", "CONTENT_MISMATCH", 422);
  const media = object(data.media);
  const candidates = [media.video, ...(Array.isArray(media.streams) ? media.streams : [])].map(object).filter(stream => isMediaUrl(stream.url));
  const rank = (stream: ObjectValue) => (stream.watermark === false ? 2 : stream.watermark === true ? 0 : 1);
  candidates.sort((a, b) => rank(b) - rank(a) || positive(b.width) * positive(b.height) - positive(a.width) * positive(a.height) || positive(b.bitrate) - positive(a.bitrate));
  const stream = candidates[0];
  if (!stream) throw new ServiceError("没有可用的视频流，或媒体域名暂未受支持。", "NO_MEDIA", 422);
  const bytes = positive(stream.size_bytes);
  if (bytes > MAX_VIDEO_BYTES) throw new ServiceError("当前版本支持 200 MB 以内的视频。", "VIDEO_TOO_LARGE", 422);
  const urls = [...new Set([stream.url, ...(Array.isArray(stream.urls) ? stream.urls : [])].filter(isMediaUrl))].slice(0, 3);
  const author = object(data.author);
  const description = typeof data.description === "string" ? data.description : typeof data.title === "string" ? data.title : "抖音视频";
  const mediaToken = await signToken({ kind: "media", urls, contentId, bytes }, config.tokenSecret);
  return { status: "ready", video: {
    contentId, title: description.slice(0, 500), author: typeof author.nickname === "string" ? author.nickname.slice(0, 100) : "抖音创作者",
    width: positive(stream.width), height: positive(stream.height), duration: positive(data.duration_seconds) || positive(media.duration_seconds),
    bytes, watermark: typeof stream.watermark === "boolean" ? stream.watermark : null, mediaToken,
  } };
}

async function shapeResult(data: ObjectValue, source: string, config: ApiConfig): Promise<ParseResponse> {
  if (!data.task_id) return shapeVideo(data, source, config);
  if (data.state === "done") return shapeVideo(object(data.data), source, config);
  if (data.state === "failed") {
    const upstream = object(data.error);
    const code = typeof upstream.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(upstream.code) ? upstream.code : "PARSE_FAILED";
    throw new ServiceError(`作品解析失败（${code}）。`, code, 422, /BLOCKED|IDENTITY|UNAVAILABLE|RATE_LIMIT|TIMEOUT/.test(code));
  }
  if (!["queued", "running"].includes(String(data.state)) || typeof data.task_id !== "string" || !/^[\w-]{1,200}$/.test(data.task_id)) throw new ServiceError("解析服务返回了无效任务。", "INVALID_TASK", 502, true);
  return { status: "pending", taskToken: await signToken({ kind: "task", taskId: data.task_id, source }, config.tokenSecret) };
}

export async function parseVideo(rawUrl: string, config: ApiConfig): Promise<ParseResponse> {
  const source = normalizeLink(rawUrl);
  if (!source) throw new ServiceError("请输入受支持的抖音视频链接。", "INVALID_URL", 400);
  const headers = await authHeaders(config);
  const { data } = await requestJson(config, "/api/v1/parse?wait=20&lang=zh", headers, { url: source });
  return shapeResult(data, source, config);
}

export async function pollVideo(taskId: string, source: string, config: ApiConfig): Promise<ParseResponse> {
  if (!/^[\w-]{1,200}$/.test(taskId) || !normalizeLink(source)) throw new ServiceError("解析任务信息无效。", "INVALID_TASK", 400);
  const { data } = await requestJson(config, `/api/v1/tasks/${encodeURIComponent(taskId)}?lang=zh`, await authHeaders(config));
  return shapeResult(data, source, config);
}
