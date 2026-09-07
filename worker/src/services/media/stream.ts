import type { StreamBindingLike, StreamVideoLike } from '../../cloudflare/stream';
import { createStreamSourceToken } from '../../security/stream-source-token';

type StreamProject = {
  id: string;
  sourceObjectKey?: string | null;
  streamVideoUid?: string | null;
  streamSourceObjectKey?: string | null;
  streamReadyAt?: string | null;
};

type StreamProjectStore = {
  getByIdForUser(projectId: string, userId: string): Promise<StreamProject | null>;
  setStreamProvenance(
    projectId: string,
    userId: string,
    sourceObjectKey: string,
    videoUid: string,
    readyAt?: string | null,
  ): Promise<void>;
};

type WaitLike = (milliseconds: number) => Promise<void>;

type StreamMediaServiceDeps = {
  projects: StreamProjectStore;
  stream: StreamBindingLike;
  publicOrigin: string;
  signingSecret: string;
  nowSeconds?: () => number;
  wait?: WaitLike;
};

export type PreparedStreamSource = {
  sourceId: string;
  durationMs: number;
  audioUrl: string;
};

const SOURCE_URL_TTL_SECONDS = 15 * 60;
const MAX_READY_POLLS = 30;
const POLL_DELAY_MS = 1_000;

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ready(video: StreamVideoLike): boolean {
  return video.readyToStream === true || video.status?.state === 'ready';
}

function terminalFailure(video: StreamVideoLike): string | null {
  const state = video.status?.state?.toLowerCase();
  if (!state || state === 'ready' || state === 'queued' || state === 'inprogress' || state === 'processing') return null;
  if (state === 'error' || state === 'failed') {
    return video.status?.errorReasonText || video.status?.errorReasonCode || 'Cloudflare Stream ingest failed.';
  }
  return null;
}

function durationMs(video: StreamVideoLike): number {
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('STREAM_NOT_READY: Stream source duration is unavailable.');
  return Math.round(duration * 1000);
}

export class StreamMediaService {
  private readonly nowSeconds: () => number;
  private readonly wait: WaitLike;

  constructor(private readonly deps: StreamMediaServiceDeps) {
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.wait = deps.wait ?? defaultWait;
  }

  private async signedSourceUrl(projectId: string, sourceObjectKey: string): Promise<string> {
    const origin = this.deps.publicOrigin.trim();
    if (!origin) throw new Error('STREAM_BINDING_UNAVAILABLE: Public origin is missing.');
    const expires = this.nowSeconds() + SOURCE_URL_TTL_SECONDS;
    const signature = await createStreamSourceToken(
      this.deps.signingSecret,
      projectId,
      sourceObjectKey,
      expires,
    );
    const url = new URL(`/api/stream-source/${encodeURIComponent(projectId)}`, origin);
    url.searchParams.set('key', sourceObjectKey);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);
    return url.toString();
  }

  private async waitForReady(sourceId: string): Promise<StreamVideoLike> {
    const handle = this.deps.stream.video(sourceId);
    for (let attempt = 0; attempt < MAX_READY_POLLS; attempt += 1) {
      const video = await handle.details();
      const failure = terminalFailure(video);
      if (failure) throw new Error(`STREAM_INGEST_FAILED: ${failure}`);
      if (ready(video)) return video;
      if (attempt + 1 < MAX_READY_POLLS) await this.wait(POLL_DELAY_MS);
    }
    throw new Error('STREAM_NOT_READY: Cloudflare Stream source did not become ready in time.');
  }

  private async waitForAudio(sourceId: string): Promise<string> {
    const downloads = this.deps.stream.video(sourceId).downloads;
    await downloads.generate('audio');
    for (let attempt = 0; attempt < MAX_READY_POLLS; attempt += 1) {
      const variant = (await downloads.get()).audio;
      if (variant?.status === 'ready' && typeof variant.url === 'string' && variant.url.trim()) {
        return variant.url;
      }
      if (variant?.status === 'error' || variant?.status === 'failed') {
        throw new Error('STREAM_DOWNLOAD_FAILED: Stream audio download generation failed.');
      }
      if (attempt + 1 < MAX_READY_POLLS) await this.wait(POLL_DELAY_MS);
    }
    throw new Error('STREAM_DOWNLOAD_FAILED: Stream audio download did not become ready in time.');
  }

  async prepareSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedStreamSource> {
    const project = await this.deps.projects.getByIdForUser(projectId, userId);
    if (!project) throw new Error('Project not found.');
    if (!sourceObjectKey || project.sourceObjectKey !== sourceObjectKey) {
      throw new Error('STREAM_INGEST_FAILED: Project source media changed before Stream ingest.');
    }

    const reusable = Boolean(
      project.streamVideoUid
      && project.streamSourceObjectKey === sourceObjectKey,
    );

    let sourceId = reusable ? project.streamVideoUid! : '';
    if (!sourceId) {
      const sourceUrl = await this.signedSourceUrl(projectId, sourceObjectKey);
      let uploaded: StreamVideoLike;
      try {
        uploaded = await this.deps.stream.upload(sourceUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cloudflare Stream ingest failed.';
        throw new Error(`STREAM_INGEST_FAILED: ${message}`);
      }
      sourceId = uploaded.id?.trim();
      if (!sourceId) throw new Error('STREAM_INGEST_FAILED: Stream ingest returned no video id.');
    }

    const video = await this.waitForReady(sourceId);
    if (!reusable) {
      await this.deps.projects.setStreamProvenance(
        projectId,
        userId,
        sourceObjectKey,
        sourceId,
        video.readyToStreamAt ?? null,
      );
    }

    const audioUrl = await this.waitForAudio(sourceId);
    return {
      sourceId,
      durationMs: durationMs(video),
      audioUrl,
    };
  }

  async ensureSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedStreamSource> {
    return this.prepareSource(projectId, userId, sourceObjectKey);
  }
}
