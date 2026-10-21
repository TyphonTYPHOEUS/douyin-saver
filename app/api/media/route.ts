import { getConfig } from "@/lib/douyin/config";
import { failureResponse, ServiceError } from "@/lib/douyin/errors";
import { guard } from "@/lib/douyin/guard";
import { fetchMedia, isMediaUrl, MAX_VIDEO_BYTES } from "@/lib/douyin/media";
import { verifyToken } from "@/lib/douyin/tokens";

export async function GET(request: Request) {
  try {
    guard(request, "media");
    const ticket = await verifyToken(new URL(request.url).searchParams.get("token") || "", getConfig().tokenSecret, "media");
    const urls = Array.isArray(ticket.urls) ? ticket.urls.filter(isMediaUrl).slice(0, 3) : [];
    if (!urls.length || typeof ticket.contentId !== "string" || !/^\d{1,32}$/.test(ticket.contentId)) throw new ServiceError("媒体信息无效，请重新解析。", "INVALID_MEDIA", 422);
    for (const url of urls) {
      let upstream: Response;
      try { upstream = await fetchMedia(url); } catch { continue; }
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); continue; }
      const length = Number(upstream.headers.get("content-length") || 0);
      const type = upstream.headers.get("content-type") || "application/octet-stream";
      if (length > MAX_VIDEO_BYTES) { await upstream.body.cancel(); throw new ServiceError("视频超过 200 MB，暂不支持浏览器内校验。", "VIDEO_TOO_LARGE", 422); }
      if (!/^(video\/|application\/(octet-stream|mp4))/.test(type)) { await upstream.body.cancel(); continue; }
      const headers = new Headers({
        "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="douyin_${ticket.contentId}.mp4"`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      });
      if (length > 0) headers.set("Content-Length", String(length));
      return new Response(upstream.body, { status: 200, headers });
    }
    throw new ServiceError("视频地址已过期或传输失败，请重新解析后再保存。", "MEDIA_UNAVAILABLE", 410);
  } catch (error) { return failureResponse(error); }
}
