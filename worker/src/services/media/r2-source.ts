import { MAX_MEDIA_DURATION_SECONDS } from '../../../../shared/mediaPolicy';
import type { R2GetOptions, R2ObjectBodyLike, R2ObjectMetadataLike } from '../../cloudflare/r2';
import { createMediaSourceToken } from '../../security/media-source-token';
import { createR2MediaSource } from './r2-mediabunny-source';
import { assertRemuxableSource } from './r2-remux';

const SOURCE_URL_TTL_SECONDS = 15 * 60;

type R2SourceProject = {
  id: string;
  sourceObjectKey?: string | null;
  durationMs?: number | null;
};

type R2SourceProjectStore = {
  getByIdForUser(projectId: string, userId: string): Promise<R2SourceProject | null>;
};

type R2DurationProbeBucket = {
  head?(key: string): Promise<R2ObjectMetadataLike | null>;
  get?(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null>;
};

type R2SourceMediaServiceDeps = {
  projects: R2SourceProjectStore;
  bucket?: R2DurationProbeBucket;
  publicOrigin: string;
  signingSecret: string;
  nowSeconds?: () => number;
};

export type PreparedR2Source = {
  sourceId: string;
  durationMs: number | null;
  audioUrl: string;
};

function boundedDuration(value: number | null | undefined): number | null {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MEDIA_DURATION_SECONDS * 1000) return null;
  return Math.round(duration);
}

async function probeFreshR2Mp4DurationMs(
  bucket: R2DurationProbeBucket | undefined,
  sourceObjectKey: string,
): Promise<number | null> {
  if (!bucket?.head || !bucket.get) return null;

  try {
    const readableBucket = {
      head: (key: string) => bucket.head!(key),
      get: (key: string, options?: R2GetOptions) => bucket.get!(key, options),
    };
    const source = await createR2MediaSource(readableBucket, sourceObjectKey);
    const media = await assertRemuxableSource(source);
    return boundedDuration(media.durationSeconds * 1000);
  } catch {
    // Duration probing is an admission aid for the bounded Workers AI fallback.
    // Keep remote-capable ASR behavior unchanged when the source is not the
    // baseline H.264 MP4 that the R2-only standard export path can inspect.
    return null;
  }
}

export class R2SourceMediaService {
  private readonly nowSeconds: () => number;

  constructor(private readonly deps: R2SourceMediaServiceDeps) {
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async prepareSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedR2Source> {
    const project = await this.deps.projects.getByIdForUser(projectId, userId);
    if (!project) throw new Error('MEDIA_SOURCE_NOT_FOUND: Project not found.');
    if (!sourceObjectKey || project.sourceObjectKey !== sourceObjectKey) {
      throw new Error('MEDIA_SOURCE_CHANGED: Project source media changed before transcription.');
    }

    const origin = this.deps.publicOrigin.trim();
    if (!origin) throw new Error('MEDIA_SOURCE_ORIGIN_UNAVAILABLE: Public origin is missing.');
    const secret = this.deps.signingSecret.trim();
    if (!secret) throw new Error('MEDIA_SOURCE_SIGNING_UNAVAILABLE: Media source signing secret is missing.');

    const storedDurationMs = boundedDuration(project.durationMs);
    const durationMs = storedDurationMs
      ?? await probeFreshR2Mp4DurationMs(this.deps.bucket, sourceObjectKey);

    const expires = this.nowSeconds() + SOURCE_URL_TTL_SECONDS;
    const signature = await createMediaSourceToken(secret, projectId, sourceObjectKey, expires);
    const url = new URL(`/api/media-source/${encodeURIComponent(projectId)}`, origin);
    url.searchParams.set('key', sourceObjectKey);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);

    return {
      sourceId: sourceObjectKey,
      durationMs,
      audioUrl: url.toString(),
    };
  }
}
