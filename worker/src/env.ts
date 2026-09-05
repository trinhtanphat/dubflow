import type { D1DatabaseLike } from './db/projects';
import type { AiBinding } from './cloudflare/ai';
import type { R2BucketLike } from './cloudflare/r2';

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1DatabaseLike;
  MEDIA: R2BucketLike;
  AI: AiBinding;
  ASSETS: AssetFetcher;
  GOOGLE_CLOUD_TRANSLATE_API_KEY?: string;
}
