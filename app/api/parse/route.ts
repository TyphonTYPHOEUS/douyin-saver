import { getConfig } from "@/lib/douyin/config";
import { parseVideo } from "@/lib/douyin/api-client";
import { failureResponse, ServiceError } from "@/lib/douyin/errors";
import { guard, jsonBody } from "@/lib/douyin/guard";

export async function POST(request: Request) {
  try {
    guard(request, "parse");
    const body = await jsonBody(request);
    if (typeof body.url !== "string" || body.url.length > 4096) throw new ServiceError("请提供单个抖音视频链接。", "INVALID_URL", 400);
    return Response.json(await parseVideo(body.url, getConfig()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failureResponse(error); }
}
