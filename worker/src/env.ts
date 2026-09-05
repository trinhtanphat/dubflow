export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  GOOGLE_CLOUD_TRANSLATE_API_KEY?: string;
}
