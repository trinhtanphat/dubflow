import { describe, expect, it } from 'vitest';
import type { Segment, StudioProject } from '../features/timeline/types';
import { HISTORY_LIMIT, applyMutation, pushHistory, type EditorMutation } from './editorHistory';

const base: Segment = {
  id: 's1', speakerId: 'sp1', startMs: 100, endMs: 900,
  sourceText: 'source old', translatedText: 'translation old', version: 10,
};
const project: StudioProject = {
  id: 'p1', title: 'P', durationMs: 1000, sourceLanguage: 'en', targetLanguage: 'vi',
  speakers: [{ id: 'sp1', name: 'One', label: '1', share: 100 }], segments: [base],
};

function fieldMutation(index = 0): EditorMutation {
  return {
    kind: 'fields',
    segmentId: 's1',
    fields: ['translatedText'],
    before: { ...base, translatedText: `old-${index}`, version: 2 },
    after: { ...base, translatedText: `new-${index}`, version: 3 },
  } as EditorMutation;
}

describe('field mutation history', () => {
  it('applies only named fields and preserves current timing/revision', () => {
    const current = {
      ...project,
      segments: [{ ...base, sourceText: 'newer source', startMs: 200, endMs: 950, version: 10 }],
    };
    const mutation = fieldMutation();
    const forward = applyMutation(current, mutation, 'forward');
    expect(forward.segments[0]).toMatchObject({
      translatedText: 'new-0', sourceText: 'newer source', startMs: 200, endMs: 950, version: 10,
    });
    const backward = applyMutation(forward, mutation, 'backward');
    expect(backward.segments[0]).toMatchObject({
      translatedText: 'old-0', sourceText: 'newer source', startMs: 200, endMs: 950, version: 10,
    });
  });

  it('still bounds mixed field history to the newest 100 commits', () => {
    let history = { past: [] as EditorMutation[], future: [] as EditorMutation[] };
    for (let index = 0; index < HISTORY_LIMIT + 1; index += 1) history = pushHistory(history, fieldMutation(index));
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect((history.past[0] as any).after.translatedText).toBe('new-1');
  });
});
