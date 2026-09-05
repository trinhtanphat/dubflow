import { describe, expect, it } from 'vitest';
import { runCloudUploadFlow } from './cloudUploadFlow';

describe('cloud upload flow', () => {
  it('runs create -> multipart upload -> Workflow processing in order', async () => {
    const calls: string[] = [];
    const file = new File(['video'], 'episode.mp4', { type: 'video/mp4' });
    const result = await runCloudUploadFlow(file, 'zh', {
      async createProject(title, sourceLanguage) {
        calls.push(`create:${title}:${sourceLanguage}`);
        return { id: 'p1', userId: 'u', title, sourceLanguage, targetLanguage: 'vi', status: 'draft' as const };
      },
      async uploadMedia(projectId, uploadedFile, _fetch, onProgress) {
        calls.push(`upload:${projectId}:${uploadedFile.name}`);
        onProgress?.(1);
        return { objectKey: 'projects/p1/source/x.mp4', size: uploadedFile.size };
      },
      async startProcessing(projectId) {
        calls.push(`process:${projectId}`);
        return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const };
      },
    });
    expect(calls).toEqual(['create:episode:zh', 'upload:p1:episode.mp4', 'process:p1']);
    expect(result).toMatchObject({ project: { id: 'p1' }, job: { jobId: 'j1', workflowId: 'w1' } });
  });

  it('does not start processing when multipart upload fails', async () => {
    let processed = false;
    const file = new File(['video'], 'episode.mp4', { type: 'video/mp4' });
    await expect(runCloudUploadFlow(file, 'zh', {
      async createProject(title, sourceLanguage) { return { id: 'p1', userId: 'u', title, sourceLanguage, targetLanguage: 'vi', status: 'draft' as const }; },
      async uploadMedia() { throw new Error('R2 failed'); },
      async startProcessing() { processed = true; return { jobId: 'j1', workflowId: 'w1', status: 'queued' as const }; },
    })).rejects.toThrow('R2 failed');
    expect(processed).toBe(false);
  });
});
