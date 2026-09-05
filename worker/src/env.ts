import type { D1DatabaseLike } from './db/projects';

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1DatabaseLike;
  MEDIA: unknown;
  AI: unknown;
  ASSETS: AssetFetcher;
}
