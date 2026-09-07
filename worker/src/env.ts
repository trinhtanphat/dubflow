import type { D1DatabaseLike } from './db/projects';
import type { AiBinding } from './cloudflare/ai';
import type { R2MediaBucketLike } from './cloudflare/r2';

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export type WorkflowInstanceLike = { id: string };

export interface WorkflowBindingLike {
  create(input: { id?: string; params?: unknown }): Promise<WorkflowInstanceLike>;
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface RateLimitBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1DatabaseLike;
  MEDIA: R2MediaBucketLike;
  AI: AiBinding;
  ASSETS: AssetFetcher;
  ANALYTICS: AnalyticsEngineDatasetLike;
  RATE_LIMIT_PROCESS: RateLimitBindingLike;
  RATE_LIMIT_EXPORT: RateLimitBindingLike;
  RATE_LIMIT_TRANSLATE: RateLimitBindingLike;
  RATE_LIMIT_VOICE: RateLimitBindingLike;
  RATE_LIMIT_UPLOAD: RateLimitBindingLike;
  RATE_LIMIT_VOICE_CLONE: RateLimitBindingLike;
  RATE_LIMIT_BATCH_EXPORT: RateLimitBindingLike;
  DUBBING_WORKFLOW: WorkflowBindingLike;
  EXPORT_WORKFLOW: WorkflowBindingLike;
  LANGUAGE_TRANSLATION_WORKFLOW: WorkflowBindingLike;
  PUBLIC_ORIGIN?: string;
  MEDIA_SOURCE_SIGNING_SECRET?: string;
  STREAM_SOURCE_SIGNING_SECRET?: string;
  CONTEXT_TRANSLATION_MODEL?: string;
  GOOGLE_CLOUD_TRANSLATE_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
  PAID_GROK_TTS_ENABLED?: string;
  SYNC_API_KEY?: string;
  SYNC_LIPSYNC_QUALIFIED?: string;
}
