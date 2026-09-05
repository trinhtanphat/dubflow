import { describe, expect, it } from 'vitest';
import { followCloudJob } from './cloudJobFlow';

describe('cloud job follow flow', () => {
  it('reports job updates then hydrates persisted studio data at needs_review', async () => {
    const calls: string[] = [];
    const updates: string[] = [];
    const studio = await followCloudJob('p1', 'j1', {
      async poll(_projectId, _jobId, options) {
        const running = { id: 'j1', projectId: 'p1', type: 'dubbing', status: 'running' as const, progress: 0.6, currentStep: 'transcribing', errorCode: null, errorMessage: null };
        options.onJob?.(running);
        return { ...running, status: 'needs_review' as const, progress: 1, currentStep: null };
      },
      async hydrate(projectId) {
        calls.push(`hydrate:${projectId}`);
        return { id: projectId, title: 'Cloud', durationMs: 1000, sourceLanguage: 'zh', targetLanguage: 'vi', speakers: [], segments: [] };
      },
    }, undefined, (job) => updates.push(`${job.status}:${job.progress}`));

    expect(updates).toEqual(['running:0.6', 'needs_review:1']);
    expect(calls).toEqual(['hydrate:p1']);
    expect(studio?.title).toBe('Cloud');
  });

  it('surfaces a failed terminal job without hydrating stale editor data', async () => {
    let hydrated = false;
    await expect(followCloudJob('p1', 'j1', {
      async poll() {
        return { id: 'j1', projectId: 'p1', type: 'dubbing', status: 'failed' as const, progress: 0.4, currentStep: 'transcribing', errorCode: 'ASR_FAILED', errorMessage: 'provider down' };
      },
      async hydrate() { hydrated = true; throw new Error('must not hydrate'); },
    })).rejects.toMatchObject({ name: 'CloudJobError', code: 'ASR_FAILED', message: 'provider down' });
    expect(hydrated).toBe(false);
  });
});
