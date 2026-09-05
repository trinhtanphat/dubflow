import { describe, expect, it } from 'vitest';
import { loadCloudStudioProject } from './cloudHydration';

describe('terminal cloud hydration', () => {
  it('reloads the persisted project and segments before building the studio model', async () => {
    const calls: string[] = [];
    const studio = await loadCloudStudioProject('p1', {
      async getProject(id) {
        calls.push(`project:${id}`);
        return { id, userId: 'u', title: 'Cloud complete', sourceLanguage: 'zh', targetLanguage: 'vi', status: 'needs_review', durationMs: 9000 };
      },
      async listSegments(id) {
        calls.push(`segments:${id}`);
        return [{ id: 's1', projectId: id, speakerId: null, startMs: 1000, endMs: 2000, sourceText: '你', translatedText: 'bạn', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 1 }];
      },
    });
    expect(calls).toEqual(['project:p1', 'segments:p1']);
    expect(studio).toMatchObject({ id: 'p1', title: 'Cloud complete', durationMs: 9000 });
    expect(studio.segments[0]).toMatchObject({ sourceText: '你', translatedText: 'bạn' });
  });
});
