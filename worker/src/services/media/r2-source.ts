import { MAX_MEDIA_DURATION_SECONDS } from '../../../../shared/mediaPolicy';
import { createMediaSourceToken } from '../../security/media-source-token';

const SOURCE_URL_TTL_SECONDS = 15 * 60;

type R2SourceProject = {
  id: string;
  sourceObjectKey?: string | null;
  durationMs?: number | null;
};

type R2SourceProjectStore = {
  getByIdForUser(projectId: string, userId: string): Promise<R2SourceProject | null>;
};

type R2SourceMediaServiceDeps = {
  projects: R2SourceProjectStore;
  publicOrigin: string;
  signingSecret: string;
  durationProbe?: (sourceObjectKey: string) => Promise<number | null>;
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
    const probedDurationMs = storedDurationMs === null && this.deps.durationProbe
      ? boundedDuration(await this.deps.durationProbe(sourceObjectKey))
      : null;

    const expires = this.nowSeconds() + SOURCE_URL_TTL_SECONDS;
    const signature = await createMediaSourceToken(secret, projectId, sourceObjectKey, expires);
    const url = new URL(`/api/media-source/${encodeURIComponent(projectId)}`, origin);
    url.searchParams.set('key', sourceObjectKey);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);

    return {
      sourceId: sourceObjectKey,
      durationMs: storedDurationMs ?? probedDurationMs,
      audioUrl: url.toString(),
    };
  }
}
