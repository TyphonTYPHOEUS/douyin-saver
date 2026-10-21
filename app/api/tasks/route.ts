import { getConfig } from "@/lib/douyin/config";
import { pollVideo } from "@/lib/douyin/api-client";
import { failureResponse, ServiceError } from "@/lib/douyin/errors";
import { guard, jsonBody } from "@/lib/douyin/guard";
import { verifyToken } from "@/lib/douyin/tokens";

export async function POST(request: Request) {
  try {
    guard(request, "poll");
    const body = await jsonBody(request);
    if (typeof body.taskToken !== "string") throw new ServiceError("缺少解析任务。", "INVALID_TASK", 400);
    const config = getConfig();
    const ticket = await verifyToken(body.taskToken, config.tokenSecret, "task");
    if (typeof ticket.taskId !== "string" || typeof ticket.source !== "string") throw new ServiceError("解析任务无效。", "INVALID_TASK", 400);
    return Response.json(await pollVideo(ticket.taskId, ticket.source, config), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failureResponse(error); }
}
