import type { R2BucketLike } from '../../cloudflare/r2';
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
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type StreamMediaServiceDeps = {
  projects: StreamProjectStore;
  stream: StreamBindingLike;
  bucket?: Pick<R2BucketLike, 'put'>;
  publicOrigin: string;
  signingSecret: string;
  accountId?: string;
  apiToken?: string;
  fetcher?: FetchLike;
  nowSeconds?: () => number;
  wait?: WaitLike;
};

export type PreparedStreamSource = {
  sourceId: string;
  durationMs: number;
  audioUrl: string;
};

export type PublishDubbedExportInput = {
  projectId: string;
  userId: string;
  sourceObjectKey: string;
  soundtrackObjectKey: string;
  targetLanguage: string;
  exportId: string;
  exportObjectKey: string;
};

type StreamAudioTrack = {
  uid?: string;
  label?: string;
  default?: boolean;
  status?: string;
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
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

function audioTrackFailure(track: StreamAudioTrack): boolean {
  const status = track.status?.toLowerCase();
  return status === 'error' || status === 'failed';
}

export class StreamMediaService {
  private readonly nowSeconds: () => number;
  private readonly wait: WaitLike;
  private readonly fetcher: FetchLike;

  constructor(private readonly deps: StreamMediaServiceDeps) {
    this.nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.wait = deps.wait ?? defaultWait;
    this.fetcher = deps.fetcher ?? fetch;
  }

  private async signedObjectUrl(projectId: string, objectKey: string): Promise<string> {
    const origin = this.deps.publicOrigin.trim();
    if (!origin) throw new Error('STREAM_BINDING_UNAVAILABLE: Public origin is missing.');
    const expires = this.nowSeconds() + SOURCE_URL_TTL_SECONDS;
    const signature = await createStreamSourceToken(
      this.deps.signingSecret,
      projectId,
      objectKey,
      expires,
    );
    const url = new URL(`/api/stream-source/${encodeURIComponent(projectId)}`, origin);
    url.searchParams.set('key', objectKey);
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

  private async ensureVideoSource(projectId: string, userId: string, sourceObjectKey: string): Promise<{ sourceId: string; durationMs: number }> {
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
      const sourceUrl = await this.signedObjectUrl(projectId, sourceObjectKey);
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
    return { sourceId, durationMs: durationMs(video) };
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

  private apiCredentials(): { accountId: string; apiToken: string } {
    const accountId = this.deps.accountId?.trim() ?? '';
    const apiToken = this.deps.apiToken?.trim() ?? '';
    if (!accountId || !apiToken) {
      throw new Error('STREAM_BINDING_UNAVAILABLE: Cloudflare Stream API credentials are missing.');
    }
    return { accountId, apiToken };
  }

  private async streamApi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { accountId, apiToken } = this.apiCredentials();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${apiToken}`);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await this.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream/${path}`,
      { ...init, headers },
    );
    const payload = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || !payload?.success || payload.result === undefined) {
      const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');
      throw new Error(`STREAM_AUDIO_TRACK_FAILED: Cloudflare Stream API request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return payload.result;
  }

  private async listAudioTracks(sourceId: string): Promise<StreamAudioTrack[]> {
    const result = await this.streamApi<{ audio?: StreamAudioTrack[] }>(`${encodeURIComponent(sourceId)}/audio`);
    return Array.isArray(result.audio) ? result.audio : [];
  }

  private async findAudioTrackByLabel(sourceId: string, label: string): Promise<StreamAudioTrack | null> {
    const tracks = await this.listAudioTracks(sourceId);
    return tracks.find((track) => track.label === label) ?? null;
  }

  private async waitForAudioTrack(sourceId: string, audioTrackUid: string): Promise<StreamAudioTrack> {
    for (let attempt = 0; attempt < MAX_READY_POLLS; attempt += 1) {
      const track = (await this.listAudioTracks(sourceId)).find((item) => item.uid === audioTrackUid);
      if (track && audioTrackFailure(track)) {
        throw new Error('STREAM_AUDIO_TRACK_FAILED: Stream audio-track processing failed.');
      }
      if (track?.status === 'ready') return track;
      if (attempt + 1 < MAX_READY_POLLS) await this.wait(POLL_DELAY_MS);
    }
    throw new Error('STREAM_AUDIO_TRACK_FAILED: Stream audio track did not become ready in time.');
  }

  private async waitForDefaultDownload(sourceId: string): Promise<string> {
    const downloads = this.deps.stream.video(sourceId).downloads;
    await downloads.generate('default');
    for (let attempt = 0; attempt < MAX_READY_POLLS; attempt += 1) {
      const variant = (await downloads.get()).default;
      if (variant?.status === 'ready' && typeof variant.url === 'string' && variant.url.trim()) {
        return variant.url;
      }
      if (variant?.status === 'error' || variant?.status === 'failed') {
        throw new Error('STREAM_DOWNLOAD_FAILED: Stream MP4 download generation failed.');
      }
      if (attempt + 1 < MAX_READY_POLLS) await this.wait(POLL_DELAY_MS);
    }
    throw new Error('STREAM_DOWNLOAD_FAILED: Stream MP4 download did not become ready in time.');
  }

  async prepareSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedStreamSource> {
    const source = await this.ensureVideoSource(projectId, userId, sourceObjectKey);
    const audioUrl = await this.waitForAudio(source.sourceId);
    return { ...source, audioUrl };
  }

  async ensureSource(projectId: string, userId: string, sourceObjectKey: string): Promise<PreparedStreamSource> {
    return this.prepareSource(projectId, userId, sourceObjectKey);
  }

  async publishDubbedExport(input: PublishDubbedExportInput): Promise<{ exportObjectKey: string; audioTrackUid: string }> {
    if (!this.deps.bucket?.put) throw new Error('STREAM_DOWNLOAD_FAILED: R2 put is unavailable.');
    const source = await this.ensureVideoSource(input.projectId, input.userId, input.sourceObjectKey);
    const label = `dubflow-${input.targetLanguage}-${input.exportId}`;
    const existing = await this.findAudioTrackByLabel(source.sourceId, label);
    let audioTrackUid = existing?.uid?.trim() ?? '';

    if (!audioTrackUid) {
      const soundtrackUrl = await this.signedObjectUrl(input.projectId, input.soundtrackObjectKey);
      const copied = await this.streamApi<StreamAudioTrack>(`${encodeURIComponent(source.sourceId)}/audio/copy`, {
        method: 'POST',
        body: JSON.stringify({ label, url: soundtrackUrl }),
      });
      audioTrackUid = copied.uid?.trim() ?? '';
      if (!audioTrackUid) throw new Error('STREAM_AUDIO_TRACK_FAILED: Stream audio copy returned no track uid.');
    }

    await this.waitForAudioTrack(source.sourceId, audioTrackUid);
    await this.streamApi<StreamAudioTrack>(
      `${encodeURIComponent(source.sourceId)}/audio/${encodeURIComponent(audioTrackUid)}`,
      { method: 'PATCH', body: JSON.stringify({ default: true }) },
    );

    const downloadUrl = await this.waitForDefaultDownload(source.sourceId);
    const download = await this.fetcher(downloadUrl);
    if (!download.ok || !download.body) {
      throw new Error(`STREAM_DOWNLOAD_FAILED: Stream MP4 download failed (${download.status}).`);
    }
    await this.deps.bucket.put(input.exportObjectKey, download.body, {
      httpMetadata: { contentType: 'video/mp4' },
    });
    return { exportObjectKey: input.exportObjectKey, audioTrackUid };
  }
}
