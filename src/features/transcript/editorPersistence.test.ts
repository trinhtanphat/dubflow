import { describe, expect, it } from 'vitest';
import { persistEditorPatch, retranslateEditorSegment } from './editorPersistence';

const segment = {
  id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 1000,
  sourceText: '你好', translatedText: 'Xin chào', translationEngine: 'workers-ai',
  translationStatus: 'completed', voiceStatus: 'pending', version: 2,
};

describe('editor persistence', () => {
  it('persists source, translation and speaker patches with the expected revision', async () => {
    const calls: unknown[] = [];
    const updated = await persistEditorPatch('p1', 's1', 2, { translatedText: 'Chào bạn', speakerId: 'speaker-2' }, {
      async patchSegment(projectId, segmentId, expectedVersion, patch) {
        calls.push({ projectId, segmentId, expectedVersion, patch });
        return { ...segment, ...patch, version: 3 };
      },
    });
    expect(calls).toEqual([{
      projectId: 'p1',
      segmentId: 's1',
      expectedVersion: 2,
      patch: { translatedText: 'Chào bạn', speakerId: 'speaker-2' },
    }]);
    expect(updated).toMatchObject({ translatedText: 'Chào bạn', speakerId: 'speaker-2', version: 3 });
  });

  it('passes the expected revision through compare translation without persisting a winner', async () => {
    const calls: unknown[] = [];
    const result = await retranslateEditorSegment('p1', 's1', 2, 'compare', {
      async retranslateSegment(projectId, segmentId, expectedVersion, mode) {
        calls.push({ projectId, segmentId, expectedVersion, mode });
        return {
          mode: 'compare' as const,
          workersAI: [{ id: 's1', text: 'Bản AI', provider: 'workers-ai' }],
          google: [{ id: 's1', text: 'Bản Google', provider: 'google' }],
        };
      },
    });
    expect(calls).toEqual([{ projectId: 'p1', segmentId: 's1', expectedVersion: 2, mode: 'compare' }]);
    expect(result).toEqual({ mode: 'compare', workersAI: 'Bản AI', google: 'Bản Google' });
  });

  it('returns the persisted canonical segment for a revision-aware single-provider retranslation', async () => {
    const calls: unknown[] = [];
    const updated = { ...segment, translatedText: 'Bản mới', version: 3 };
    const result = await retranslateEditorSegment('p1', 's1', 2, 'workers-ai', {
      async retranslateSegment(projectId, segmentId, expectedVersion, mode) {
        calls.push({ projectId, segmentId, expectedVersion, mode });
        return {
          mode: 'workers-ai' as const,
          result: { id: 's1', text: 'Bản mới', provider: 'workers-ai' },
          segment: updated,
          contextRevision: null,
        };
      },
    });
    expect(calls).toEqual([{ projectId: 'p1', segmentId: 's1', expectedVersion: 2, mode: 'workers-ai' }]);
    expect(result).toEqual({ mode: 'persisted', segment: updated });
  });

  it('lets the server derive the safe mode and accepts contextual persisted results', async () => {
    const calls: unknown[] = [];
    const updated = { ...segment, translatedText: 'Theo ngữ cảnh', version: 3 };
    const result = await retranslateEditorSegment('p1', 's1', 2, undefined, {
      async retranslateSegment(projectId, segmentId, expectedVersion, mode) {
        calls.push({ projectId, segmentId, expectedVersion, mode });
        return {
          mode: 'contextual' as const,
          result: { id: 's1', text: 'Theo ngữ cảnh', provider: 'workers-ai-contextual' },
          segment: updated,
          contextRevision: 7,
        };
      },
    });

    expect(calls).toEqual([{ projectId: 'p1', segmentId: 's1', expectedVersion: 2, mode: undefined }]);
    expect(result).toEqual({ mode: 'persisted', segment: updated });
  });
});
