import { describe, expect, it } from 'vitest';
import { runCloudUploadFlow, type CloudUploadFlowDeps } from './cloudUploadFlow';

function baseProject() {
  return {
    id: 'p1', userId: 'u', title: 'episode', sourceLanguage: 'zh' as const,
    targetLanguage: 'vi' as const, status: 'ready' as const,
    sourceGeneration: 1, sourceObjectKey: 'projects/p1/source/x.mp4',
  };
}

function deps(overrides: Partial<CloudUploadFlowDeps> = {}): CloudUploadFlowDeps {
  return {
    async createProject(title, sourceLanguage) {
      return { ...baseProject(), title, sourceLanguage, status: 'draft' as const, sourceObjectKey: null };
    },
    async uploadMedia(_projectId, file, _fetch, onProgress) {
      onProgress?.(1);
      return { objectKey: 'projects/p1/source/x.mp4', size: file.size };
    },
    async getProject() { return baseProject(); },
    async prepareSourceAudio() { return { required: false, durationMs: 120_000, chunkCount: 0 }; },
    async uploadPreparedAsrChunk() { throw new Error('unexpected prepared chunk'); },
    async completePreparedAsrUpload() { throw new Error('unexpected manifest'); },
    async startProcessing() { return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const }; },
    ...overrides,
  };
}

describe('cloud upload flow', () => {
  it('runs create -> source upload -> authoritative project refresh -> inspect -> processing in order', async () => {
    const calls: string[] = [];
    const file = new File(['video'], 'episode.mp4', { type: 'video/mp4' });
    const result = await runCloudUploadFlow(file, 'zh', deps({
      async createProject(title, sourceLanguage) {
        calls.push(`create:${title}:${sourceLanguage}`);
        return { ...baseProject(), title, sourceLanguage, status: 'draft' as const, sourceObjectKey: null };
      },
      async uploadMedia(projectId, uploadedFile, _fetch, onProgress) {
        calls.push(`upload:${projectId}:${uploadedFile.name}`);
        onProgress?.(1);
        return { objectKey: 'projects/p1/source/x.mp4', size: uploadedFile.size };
      },
      async getProject(projectId) { calls.push(`refresh:${projectId}`); return baseProject(); },
      async prepareSourceAudio() {
        calls.push('prepare:inspect');
        return { required: false, durationMs: 120_000, chunkCount: 0 };
      },
      async startProcessing(projectId) {
        calls.push(`process:${projectId}`);
        return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const };
      },
    }));
    expect(calls).toEqual(['create:episode:zh', 'upload:p1:episode.mp4', 'refresh:p1', 'prepare:inspect', 'process:p1']);
    expect(result).toMatchObject({ project: { id: 'p1', sourceGeneration: 1 }, job: { jobId: 'j1', workflowId: 'w1' } });
  });

  it('uploads every prepared chunk sequentially and completes the manifest before processing', async () => {
    const calls: string[] = [];
    const file = new File(['video'], 'long.mp4', { type: 'video/mp4' });
    const result = await runCloudUploadFlow(file, 'zh', deps({
      async prepareSourceAudio(_file, consume) {
        calls.push('prepare:start');
        await consume({ index: 0, offsetMs: 0, durationMs: 300_000, wav: new ArrayBuffer(48) });
        await consume({ index: 1, offsetMs: 300_000, durationMs: 10_000, wav: new ArrayBuffer(48) });
        calls.push('prepare:end');
        return { required: true, durationMs: 310_000, chunkCount: 2 };
      },
      async uploadPreparedAsrChunk(_projectId, _generation, chunk) {
        calls.push(`chunk:${chunk.index}`);
        return {
          index: chunk.index,
          objectKey: `projects/p1/asr/source-1/chunk-${chunk.index}.wav`,
          offsetMs: chunk.offsetMs,
          durationMs: chunk.durationMs,
          sizeBytes: chunk.wav.byteLength,
        };
      },
      async completePreparedAsrUpload(_projectId, _generation, durationMs, chunks) {
        calls.push(`manifest:${durationMs}:${chunks.length}`);
      },
      async startProcessing(projectId) {
        calls.push(`process:${projectId}`);
        return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const };
      },
    }));

    expect(calls).toEqual(['prepare:start', 'chunk:0', 'chunk:1', 'prepare:end', 'manifest:310000:2', 'process:p1']);
    expect(result.job.jobId).toBe('j1');
  });

  it('does not start processing when multipart upload fails', async () => {
    let processed = false;
    const file = new File(['video'], 'episode.mp4', { type: 'video/mp4' });
    await expect(runCloudUploadFlow(file, 'zh', deps({
      async uploadMedia() { throw new Error('R2 failed'); },
      async startProcessing() { processed = true; return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const }; },
    }))).rejects.toThrow('R2 failed');
    expect(processed).toBe(false);
  });

  it('fails closed when the refreshed source generation is unavailable', async () => {
    let processed = false;
    const file = new File(['video'], 'episode.mp4', { type: 'video/mp4' });
    await expect(runCloudUploadFlow(file, 'zh', deps({
      async getProject() { return { ...baseProject(), sourceGeneration: undefined }; },
      async startProcessing() { processed = true; return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const }; },
    }))).rejects.toThrow('source generation');
    expect(processed).toBe(false);
  });
});
