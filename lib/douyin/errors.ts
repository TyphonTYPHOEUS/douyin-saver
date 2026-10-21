export class ServiceError extends Error {
  code: string;
  status: number;
  serviceBlocked: boolean;
  retryAfter?: number;
  constructor(message: string, code = "SERVICE_ERROR", status = 502, serviceBlocked = false, retryAfter?: number) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.serviceBlocked = serviceBlocked;
    this.retryAfter = retryAfter;
  }
}

export function failureResponse(error: unknown): Response {
  const known = error instanceof ServiceError;
  return Response.json({
    error: known ? error.message : "服务暂时无法完成请求，请稍后重试。",
    code: known ? error.code : "INTERNAL_ERROR",
    serviceBlocked: known ? error.serviceBlocked : true,
    ...(known && error.retryAfter ? { retryAfter: error.retryAfter } : {}),
  }, { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
