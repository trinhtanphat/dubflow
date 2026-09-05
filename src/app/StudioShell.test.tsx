import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer, type StudioAction } from './studioState';
import { createStudioEditorActions } from './StudioShell';
import type { SplitMutation, TimingMutation } from './editorHistory';

describe('StudioShell mobile controls', () => {
  it('exposes accessible source and inspector panel controls', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('aria-label="Mở nguồn media"');
    expect(html).toContain('aria-label="Mở inspector"');
  });
});

describe('StudioShell durable editor wiring', () => {
  function cloudState() {
    return createInitialStudioState({ ...mockProject, id: 'cloud-p1' });
  }

  function harness(state = cloudState()) {
    const dispatched: StudioAction[] = [];
    const busy: boolean[] = [];
    const errors: string[] = [];
    const restoreCloudProject = vi.fn(async () => {});
    const services = {
      commitSegmentTiming: vi.fn(),
      commitSegmentSplit: vi.fn(),
      persistUndo: vi.fn(),
      persistRedo: vi.fn(),
    };
    const actions = createStudioEditorActions({
      state,
      dispatch: (action) => dispatched.push(action),
      cloudEditable: true,
      busy: false,
      setBusy: (value) => busy.push(value),
      setError: (value) => errors.push(value),
      restoreCloudProject,
      services: services as any,
    });
    return { actions, dispatched, busy, errors, restoreCloudProject, services };
  }

  it('persists a timing edit before committing one canonical history entry', async () => {
    const state = cloudState();
    const before = state.project.segments[0]!;
    const after = { ...before, startMs: before.startMs + 200, endMs: before.endMs + 200 };
    const mutation: TimingMutation = { kind: 'timing', segmentId: before.id, before, after };
    const h = harness(state);
    h.services.commitSegmentTiming.mockResolvedValue(mutation);

    await h.actions.commitSegmentEdit({ kind: 'move', segmentId: before.id, startMs: after.startMs, endMs: after.endMs });

    expect(h.services.commitSegmentTiming).toHaveBeenCalledWith(state.project.id, before, { startMs: after.startMs, endMs: after.endMs });
    expect(h.dispatched).toEqual([{ type: 'commitTimingMutation', before, after }]);
    expect(h.busy).toEqual([true, false]);
    expect(h.restoreCloudProject).not.toHaveBeenCalled();
  });

  it('persists a split before committing Worker-canonical left and right rows', async () => {
    const state = cloudState();
    const originalBefore = state.project.segments[0]!;
    const playheadMs = originalBefore.startMs + Math.floor((originalBefore.endMs - originalBefore.startMs) / 2);
    const mutation: SplitMutation = {
      kind: 'split',
      originalBefore,
      leftAfter: { ...originalBefore, endMs: playheadMs, sourceText: 'left', translatedText: 'trai' },
      rightAfter: { ...originalBefore, id: 'worker-child', startMs: playheadMs, sourceText: 'right', translatedText: 'phai' },
    };
    const h = harness({ ...state, playheadMs });
    h.services.commitSegmentSplit.mockResolvedValue(mutation);

    await h.actions.splitSelected();

    expect(h.services.commitSegmentSplit).toHaveBeenCalledWith(state.project.id, originalBefore, playheadMs);
    expect(h.dispatched).toEqual([{
      type: 'commitSplitMutation',
      originalBefore,
      leftAfter: mutation.leftAfter,
      rightAfter: mutation.rightAfter,
    }]);
  });

  it('applies undo locally first and restores the local history pointer when persistence fails', async () => {
    const state = cloudState();
    const before = state.project.segments[0]!;
    const after = { ...before, startMs: before.startMs + 200, endMs: before.endMs + 200 };
    const committed = studioReducer(state, { type: 'commitTimingMutation', before, after });
    const h = harness(committed);
    h.services.persistUndo.mockRejectedValue(new Error('SEGMENT_OVERLAP'));

    await h.actions.undo();

    expect(h.services.persistUndo).toHaveBeenCalledWith(committed.project.id, committed.history.past[0]);
    expect(h.dispatched).toEqual([{ type: 'applyUndoLocal' }, { type: 'applyRedoLocal' }]);
    expect(h.errors.at(-1)).toBe('SEGMENT_OVERLAP');
  });

  it('reconciles a redone split to the fresh Worker child id', async () => {
    const state = cloudState();
    const originalBefore = state.project.segments[0]!;
    const playheadMs = originalBefore.startMs + Math.floor((originalBefore.endMs - originalBefore.startMs) / 2);
    const oldMutation: SplitMutation = {
      kind: 'split',
      originalBefore,
      leftAfter: { ...originalBefore, endMs: playheadMs, sourceText: 'left old', translatedText: 'trai cu' },
      rightAfter: { ...originalBefore, id: 'child-old', startMs: playheadMs, sourceText: 'right old', translatedText: 'phai cu' },
    };
    let undone = studioReducer(state, {
      type: 'commitSplitMutation',
      originalBefore,
      leftAfter: oldMutation.leftAfter,
      rightAfter: oldMutation.rightAfter,
    });
    undone = studioReducer(undone, { type: 'applyUndoLocal' });
    const canonical: SplitMutation = {
      ...oldMutation,
      leftAfter: { ...oldMutation.leftAfter, sourceText: 'left canonical' },
      rightAfter: { ...oldMutation.rightAfter, id: 'child-new', sourceText: 'right canonical' },
    };
    const h = harness(undone);
    h.services.persistRedo.mockResolvedValue(canonical);

    await h.actions.redo();

    expect(h.services.persistRedo).toHaveBeenCalledWith(undone.project.id, oldMutation);
    expect(h.dispatched).toEqual([
      { type: 'applyRedoLocal' },
      { type: 'reconcileLatestSplitMutation', previousRightId: oldMutation.rightAfter.id, mutation: canonical },
    ]);
  });

  it('cancels preview and reloads the durable project after a rejected new timing commit', async () => {
    const state = cloudState();
    const before = state.project.segments[0]!;
    const h = harness(state);
    h.services.commitSegmentTiming.mockRejectedValue(new Error('SEGMENT_OVERLAP'));

    await h.actions.commitSegmentEdit({ kind: 'resize', edge: 'right', segmentId: before.id, startMs: before.startMs, endMs: before.endMs + 200 });

    expect(h.dispatched).toEqual([{ type: 'cancelSegmentPreview' }]);
    expect(h.restoreCloudProject).toHaveBeenCalledTimes(1);
    expect(h.errors.at(-1)).toBe('SEGMENT_OVERLAP');
  });
});
