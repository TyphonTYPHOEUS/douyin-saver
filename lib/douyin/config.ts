import { env } from "cloudflare:workers";

export function getConfig() {
  const values = env as unknown as Record<string, string | undefined>;
  return {
    apiBase: (values.DTK_API_BASE || process.env.DTK_API_BASE || "https://demo.douyin.wtf").replace(/\/$/, ""),
    apiKey: values.DTK_API_KEY || process.env.DTK_API_KEY || "",
    tokenSecret: values.MEDIA_TOKEN_SECRET || process.env.MEDIA_TOKEN_SECRET || "",
  };
}
