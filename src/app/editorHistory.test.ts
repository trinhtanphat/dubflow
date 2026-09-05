import { describe, expect, it } from 'vitest';
import type { Segment, StudioProject } from '../features/timeline/types';
import {
  HISTORY_LIMIT,
  applyMutation,
  pushHistory,
  redoHistory,
  undoHistory,
  type EditorMutation,
} from './editorHistory';

const base: Segment = {
  id: 's1',
  speakerId: 'sp1',
  startMs: 1000,
  endMs: 2000,
  sourceText: 'hello world',
  translatedText: 'xin chao',
};

const project: StudioProject = {
  id: 'p1',
  title: 'Project',
  durationMs: 5000,
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  speakers: [{ id: 'sp1', name: 'Speaker', label: 'SP', share: 1 }],
  segments: [base],
};

function timingMutation(offset: number): EditorMutation {
  return {
    kind: 'timing',
    segmentId: 's1',
    before: { ...base, startMs: 1000 + offset, endMs: 2000 + offset },
    after: { ...base, startMs: 1100 + offset, endMs: 2100 + offset },
  };
}

describe('editor history', () => {
  it('caps committed history at 100 operations and clears redo on a new commit', () => {
    let history = { past: [] as EditorMutation[], future: [timingMutation(999)] };
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      history = pushHistory(history, timingMutation(index));
    }
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.future).toEqual([]);
    expect(history.past[0]).toEqual(timingMutation(5));
  });

  it('undoes and redoes timing mutations', () => {
    const mutation = timingMutation(0);
    const forward = applyMutation(project, mutation, 'forward');
    expect(forward.segments[0]).toMatchObject({ startMs: 1100, endMs: 2100 });
    const backward = applyMutation(forward, mutation, 'backward');
    expect(backward.segments[0]).toMatchObject({ startMs: 1000, endMs: 2000 });

    const undo = undoHistory({ past: [mutation], future: [] });
    expect(undo.mutation).toEqual(mutation);
    expect(undo.history.past).toEqual([]);
    expect(undo.history.future).toEqual([mutation]);

    const redo = redoHistory(undo.history);
    expect(redo.mutation).toEqual(mutation);
    expect(redo.history.past).toEqual([mutation]);
    expect(redo.history.future).toEqual([]);
  });

  it('reverses a split without treating it as arbitrary deletion', () => {
    const right: Segment = { ...base, id: 's1-r', startMs: 1500, sourceText: 'world', translatedText: 'chao' };
    const left: Segment = { ...base, endMs: 1500, sourceText: 'hello', translatedText: 'xin' };
    const mutation: EditorMutation = {
      kind: 'split',
      originalBefore: base,
      leftAfter: left,
      rightAfter: right,
    };

    const forward = applyMutation(project, mutation, 'forward');
    expect(forward.segments.map((segment) => segment.id)).toEqual(['s1', 's1-r']);
    const backward = applyMutation(forward, mutation, 'backward');
    expect(backward.segments).toEqual([base]);
  });
});
