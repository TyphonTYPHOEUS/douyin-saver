import { ServiceError } from "./errors.ts";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new ServiceError("网站尚未配置下载签名密钥，请联系部署者。", "MISSING_SECRET", 503, true);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signToken(payload: Record<string, unknown>, secret: string, now = Date.now()): Promise<string> {
  const body = encode(new TextEncoder().encode(JSON.stringify({ ...payload, expiresAt: now + 10 * 60_000 })));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function verifyToken(token: string, secret: string, kind: "media" | "task", now = Date.now()): Promise<Record<string, unknown>> {
  const signingKey = await key(secret);
  try {
    if (token.length > 20_000) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", signingKey, decode(parts[1]), new TextEncoder().encode(parts[0]))) throw new Error();
    const body = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (body.kind !== kind || !Number.isFinite(body.expiresAt) || body.expiresAt <= now || body.expiresAt > now + 10 * 60_000 + 5000) throw new Error();
    return body;
  } catch {
    throw new ServiceError("下载信息已失效，请重新解析作品。", "EXPIRED_TOKEN", 410);
  }
}
