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

  it('keeps compare translations as choices without persisting a winner', async () => {
    const result = await retranslateEditorSegment('p1', 's1', 'compare', {
      async retranslateSegment() {
        return {
          mode: 'compare' as const,
          workersAI: [{ id: 's1', text: 'Bản AI', provider: 'workers-ai' }],
          google: [{ id: 's1', text: 'Bản Google', provider: 'google' }],
        };
      },
    });
    expect(result).toEqual({ mode: 'compare', workersAI: 'Bản AI', google: 'Bản Google' });
  });

  it('returns the persisted segment for a single-provider retranslation', async () => {
    const updated = { ...segment, translatedText: 'Bản mới', version: 3 };
    const result = await retranslateEditorSegment('p1', 's1', 'workers-ai', {
      async retranslateSegment() {
        return { mode: 'workers-ai' as const, result: { id: 's1', text: 'Bản mới', provider: 'workers-ai' }, segment: updated };
      },
    });
    expect(result).toEqual({ mode: 'persisted', segment: updated });
  });
});
