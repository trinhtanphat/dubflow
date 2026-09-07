import { parseDubbedAudioMode } from '../../domain/audio-mode';
import type { TargetLanguage } from '../../domain/language';
import type { AudioChunk, ExportClip, MediaProcessor, RenderExportOptions } from './types';

export interface ContainerStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerNamespaceLike {
  getByName(name: string): ContainerStubLike;
}

export class MediaProcessorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MediaProcessorError';
  }
}

function projectPrefix(projectId: string) {
  return `projects/${projectId}/`;
}

function projectFromObjectKey(objectKey: string): string {
  const match = /^projects\/([^/]+)\//.exec(objectKey);
  if (!match?.[1]) {
    throw new MediaProcessorError('MEDIA_OBJECT_KEY_INVALID', 'Media object key is not project-scoped.');
  }
  return match[1];
}

function assertDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned an invalid duration.');
  }
  return Math.round(value);
}

function assertProjectObject(projectId: string, objectKey: string, folder?: string): void {
  const prefix = folder ? `${projectPrefix(projectId)}${folder}/` : projectPrefix(projectId);
  if (!objectKey.startsWith(prefix)) {
    throw new MediaProcessorError('MEDIA_OBJECT_KEY_INVALID', 'Media object key does not belong to the project.');
  }
}

function targetExportKeys(projectId: string, targetLanguage: TargetLanguage, exportId: string) {
  if (!['vi', 'en', 'zh', 'ja', 'ko'].includes(targetLanguage)) {
    throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Export target language is invalid.');
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(exportId)) {
    throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Export id is invalid.');
  }
  const base = `${projectPrefix(projectId)}exports/${targetLanguage}/${exportId}`;
  return {
    exportObjectKey: `${base}.mp4`,
    audioObjectKey: `${base}.audio.wav`,
  };
}

function assertRenderOptions(projectId: string, options: RenderExportOptions): void {
  targetExportKeys(projectId, options.targetLanguage, options.exportId);
  const audioMode = parseDubbedAudioMode(options.audioMode);
  if (!audioMode) {
    throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Export audio mode is invalid.');
  }
  if (audioMode === 'separated_background') {
    if (typeof options.backgroundObjectKey !== 'string' || options.backgroundObjectKey.length === 0) {
      throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Separated background object is required.');
    }
    if (!options.backgroundObjectKey.startsWith(`${projectPrefix(projectId)}stems/`)) {
      throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Separated background object does not belong to the project.');
    }
  } else if (options.backgroundObjectKey !== undefined) {
    throw new MediaProcessorError('MEDIA_EXPORT_OPTIONS_INVALID', 'Background object is only valid for separated_background.');
  }
}

function assertExportClip(projectId: string, raw: ExportClip, options?: RenderExportOptions): ExportClip {
  if (
    !raw ||
    typeof raw.segmentId !== 'string' || raw.segmentId.length === 0 ||
    !Number.isInteger(raw.startMs) || raw.startMs < 0 ||
    !Number.isInteger(raw.endMs) || raw.endMs <= raw.startMs ||
    typeof raw.objectKey !== 'string'
  ) {
    throw new MediaProcessorError('MEDIA_EXPORT_CLIP_INVALID', 'Export clip is malformed.');
  }
  if (options) {
    assertProjectObject(projectId, raw.objectKey, `voices/${options.targetLanguage}`);
  } else {
    assertProjectObject(projectId, raw.objectKey, 'dubbed');
  }
  return raw;
}

export class ContainerMediaProcessor implements MediaProcessor {
  constructor(private readonly namespace: ContainerNamespaceLike | undefined) {}

  private async call(projectId: string, path: string, body: unknown): Promise<unknown> {
    if (!this.namespace || typeof this.namespace.getByName !== 'function') {
      throw new MediaProcessorError(
        'MEDIA_PROCESSOR_UNAVAILABLE',
        'FFmpeg media processor is unavailable because the container binding is not configured.',
      );
    }
    const stub = this.namespace.getByName(projectId);
    if (!stub || typeof stub.fetch !== 'function') {
      throw new MediaProcessorError(
        'MEDIA_PROCESSOR_UNAVAILABLE',
        'FFmpeg media processor is unavailable because the container instance could not be resolved.',
      );
    }
    const response = await stub.fetch(new Request(`http://ffmpeg.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new MediaProcessorError(
        'MEDIA_PROCESSOR_FAILED',
        payload.message ?? `FFmpeg container failed (${response.status}).`,
      );
    }
    return response.json();
  }

  async probe(objectKey: string): Promise<{ durationMs: number }> {
    const projectId = projectFromObjectKey(objectKey);
    const result = await this.call(projectId, '/probe', { projectId, objectKey }) as { durationMs?: unknown };
    return { durationMs: assertDuration(result.durationMs) };
  }

  async extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]> {
    assertProjectObject(projectId, objectKey);
    const result = await this.call(projectId, '/extract-audio-chunks', {
      projectId,
      objectKey,
    }) as { chunks?: unknown };
    if (!Array.isArray(result.chunks) || result.chunks.length === 0) {
      throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned no audio chunks.');
    }
    return result.chunks.map((raw) => {
      const chunk = raw as Partial<AudioChunk>;
      const durationMs = assertDuration(chunk.durationMs);
      if (
        typeof chunk.objectKey !== 'string' ||
        !chunk.objectKey.startsWith(`${projectPrefix(projectId)}audio/`) ||
        typeof chunk.offsetMs !== 'number' || !Number.isInteger(chunk.offsetMs) || chunk.offsetMs < 0 ||
        typeof chunk.overlapBeforeMs !== 'number' || !Number.isInteger(chunk.overlapBeforeMs) || chunk.overlapBeforeMs < 0 ||
        typeof chunk.overlapAfterMs !== 'number' || !Number.isInteger(chunk.overlapAfterMs) || chunk.overlapAfterMs < 0 ||
        chunk.overlapBeforeMs > durationMs || chunk.overlapAfterMs > durationMs
      ) {
        throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned a malformed audio chunk.');
      }
      return {
        objectKey: chunk.objectKey,
        offsetMs: chunk.offsetMs,
        durationMs,
        overlapBeforeMs: chunk.overlapBeforeMs,
        overlapAfterMs: chunk.overlapAfterMs,
      };
    });
  }

  async extractExportAudio(
    projectId: string,
    exportObjectKey: string,
    targetLanguage: TargetLanguage,
    exportId: string,
  ): Promise<{ audioObjectKey: string }> {
    const expected = targetExportKeys(projectId, targetLanguage, exportId);
    if (exportObjectKey !== expected.exportObjectKey) {
      throw new MediaProcessorError(
        'MEDIA_OBJECT_KEY_INVALID',
        'Export audio extraction requires the exact canonical project export object.',
      );
    }
    const result = await this.call(projectId, '/extract-export-audio', {
      projectId,
      objectKey: exportObjectKey,
      targetLanguage,
      exportId,
    }) as { audioObjectKey?: unknown };
    if (result.audioObjectKey !== expected.audioObjectKey) {
      throw new MediaProcessorError(
        'MEDIA_PROCESSOR_RESPONSE_INVALID',
        'Media processor returned an invalid export audio object key.',
      );
    }
    return { audioObjectKey: expected.audioObjectKey };
  }

  async renderExport(
    projectId: string,
    objectKey: string,
    clips: ExportClip[],
    options?: RenderExportOptions,
  ): Promise<{ exportObjectKey: string }> {
    assertProjectObject(projectId, objectKey);
    if (!Array.isArray(clips) || clips.length === 0) {
      throw new MediaProcessorError('MEDIA_EXPORT_CLIP_INVALID', 'At least one dubbed clip is required for export.');
    }
    if (options) assertRenderOptions(projectId, options);
    const validated = clips.map((clip) => assertExportClip(projectId, clip, options));
    const result = await this.call(projectId, '/render-export', {
      projectId,
      objectKey,
      clips: validated,
      ...(options ? options : {}),
    }) as { exportObjectKey?: unknown };
    const expectedKey = options
      ? targetExportKeys(projectId, options.targetLanguage, options.exportId).exportObjectKey
      : `${projectPrefix(projectId)}export/dubbed.mp4`;
    if (typeof result.exportObjectKey !== 'string' || result.exportObjectKey !== expectedKey) {
      throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned an invalid export object key.');
    }
    return { exportObjectKey: result.exportObjectKey };
  }
}
