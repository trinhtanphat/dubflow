import type { AudioChunk, MediaProcessor } from './types';

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

export class ContainerMediaProcessor implements MediaProcessor {
  constructor(private readonly namespace: ContainerNamespaceLike) {}

  private async call(projectId: string, path: string, body: unknown): Promise<unknown> {
    const stub = this.namespace.getByName(projectId);
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
    if (!objectKey.startsWith(projectPrefix(projectId))) {
      throw new MediaProcessorError('MEDIA_OBJECT_KEY_INVALID', 'Media object key does not belong to the project.');
    }
    const result = await this.call(projectId, '/extract-audio-chunks', {
      projectId,
      objectKey,
      chunkSeconds: 300,
    }) as { chunks?: unknown };
    if (!Array.isArray(result.chunks) || result.chunks.length === 0) {
      throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned no audio chunks.');
    }
    return result.chunks.map((raw) => {
      const chunk = raw as Partial<AudioChunk>;
      if (
        typeof chunk.objectKey !== 'string' ||
        !chunk.objectKey.startsWith(`${projectPrefix(projectId)}audio/`) ||
        typeof chunk.offsetMs !== 'number' || !Number.isInteger(chunk.offsetMs) || chunk.offsetMs < 0 ||
        typeof chunk.durationMs !== 'number' || !Number.isFinite(chunk.durationMs) || chunk.durationMs <= 0
      ) {
        throw new MediaProcessorError('MEDIA_PROCESSOR_RESPONSE_INVALID', 'Media processor returned a malformed audio chunk.');
      }
      return {
        objectKey: chunk.objectKey,
        offsetMs: chunk.offsetMs,
        durationMs: Math.round(chunk.durationMs),
      };
    });
  }

  async renderExport(_projectId: string): Promise<{ exportObjectKey: string }> {
    throw new MediaProcessorError('MEDIA_EXPORT_UNAVAILABLE', 'Final dubbing export is not enabled in this pipeline slice.');
  }
}
