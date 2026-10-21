declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    DTK_API_BASE?: string;
    DTK_API_KEY?: string;
    MEDIA_TOKEN_SECRET?: string;
  }
}
