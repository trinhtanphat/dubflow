import type { D1DatabaseLike } from './db/projects';
import type { AiBinding } from './cloudflare/ai';
import type { R2BucketLike } from './cloudflare/r2';
import type { ContainerNamespaceLike } from './services/media/container';

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export type WorkflowInstanceLike = { id: string };

export interface WorkflowBindingLike {
  create(input: { id?: string; params?: unknown }): Promise<WorkflowInstanceLike>;
}

export interface Env {
  DB: D1DatabaseLike;
  MEDIA: R2BucketLike;
  AI: AiBinding;
  ASSETS: AssetFetcher;
  FFMPEG_CONTAINER: ContainerNamespaceLike;
  DUBBING_WORKFLOW: WorkflowBindingLike;
  EXPORT_WORKFLOW: WorkflowBindingLike;
  GOOGLE_CLOUD_TRANSLATE_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
}
