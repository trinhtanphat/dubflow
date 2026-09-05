import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer, type StudioAction } from './studioState';
import { createStudioEditorActions, StudioShell } from './StudioShell';
import { createVoicePreviewAction } from './voicePreviewAction';
import type { FieldMutation, SplitMutation, TimingMutation } from './editorHistory';
import { SegmentVersionConflictError } from '../features/transcript/segmentApi';

function renderStudioShell() {
  const state = createInitialStudioState(mockProject);
  return renderToStaticMarkup(
    <StudioShell
      state={state}
      dispatch={() => {}}
      selectedSegment={state.project.segments[0]}
      selectedSpeaker={state.project.speakers[0]}
    />,
  );
}

describe('StudioShell mobile controls', () => {
  it('exposes accessible source and inspector panel controls', () => {
    const html = renderStudioShell();
    expect(html).toContain('aria-label="Mở nguồn media"');
    expect(html).toContain('aria-label="Mở inspector"');
  });

  it('restores the reference capability footer without overstating guarded features', () => {
    const html = renderStudioShell();
    for (const label of [
      'Dub mọi ngôn ngữ',
      'Tự nhận diện nhân vật',
      'Voice preservation',
      'Chạy trên Cloud 24/7',
      'AI voices',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('reference-feature-strip');
    expect((html.match(/Capability-gated/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('StudioShell live voice preview wiring', () => {
  it('fetches Vietnamese audio, plays it, and revokes the object URL', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    const setBusy = vi.fn();
    const setError = vi.fn();
    const services = {
      fetchVoicePreview: vi.fn(async () => blob),
      createObjectURL: vi.fn(() => 'blob:yupvox-preview'),
      revokeObjectURL: vi.fn(),
      playAudio: vi.fn(async () => {}),
    };
    const preview = createVoicePreviewAction({ setBusy, setError, services });

    await preview(' Xin chào ');

    expect(services.fetchVoicePreview).toHaveBeenCalledWith({ text: 'Xin chào', language: 'vi' });
    expect(services.createObjectURL).toHaveBeenCalledWith(blob);
    expect(services.playAudio).toHaveBeenCalledWith('blob:yupvox-preview');
    expect(services.revokeObjectURL).toHaveBeenCalledWith('blob:yupvox-preview');
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(setError).toHaveBeenCalledWith('');
  });

  it('does nothing for empty preview text', async () => {
    const services = {
      fetchVoicePreview: vi.fn(),
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
      playAudio: vi.fn(),
    };
    const preview = createVoicePreviewAction({ setBusy: vi.fn(), setError: vi.fn(), services });
    await preview('   ');
    expect(services.fetchVoicePreview).not.toHaveBeenCalled();
  });
});

describe('StudioShell autosave integration', () => {
  it('renders the selected local draft and reports dirty state without mutating canonical text', () => {
    let state = createInitialStudioState({ ...mockProject, id: 'cloud-p1' });
    const canonical = state.project.segments[0]!;
    state = studioReducer(state, {
      type: 'editDraft',
      segmentId: canonical.id,
      patch: { translatedText: 'Bản nháp local chưa lưu' },
    });

    const html = renderToStaticMarkup(
      <StudioShell
        state={state}
        dispatch={() => {}}
        selectedSegment={state.project.segments[0]}
        selectedSpeaker={state.project.speakers.find((speaker) => speaker.id === canonical.speakerId)!}
      />,
    );

    expect(state.project.segments[0]?.translatedText).toBe(canonical.translatedText);
    expect(html).toContain('Bản nháp local chưa lưu');
    expect(html).toContain('Chưa lưu');
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

  it('passes the current canonical project to undo persistence and rolls the local pointer back on ordinary failure', async () => {
    const state = cloudState();
    const before = state.project.segments[0]!;
    const after = { ...before, startMs: before.startMs + 200, endMs: before.endMs + 200 };
    const committed = studioReducer(state, { type: 'commitTimingMutation', before, after });
    const h = harness(committed);
    h.services.persistUndo.mockRejectedValue(new Error('SEGMENT_OVERLAP'));

    await h.actions.undo();

    expect(h.services.persistUndo).toHaveBeenCalledWith(committed.project.id, committed.history.past[0], committed.project);
    expect(h.dispatched).toEqual([{ type: 'applyUndoLocal' }, { type: 'applyRedoLocal' }]);
    expect(h.errors.at(-1)).toBe('SEGMENT_OVERLAP');
  });

  it('turns a field-history version conflict into the same V2.5 conflict draft after rolling back optimistic undo', async () => {
    const state = cloudState();
    const current = state.project.segments[0]!;
    const mutation: FieldMutation = {
      kind: 'fields',
      segmentId: current.id,
      fields: ['translatedText'],
      before: { ...current, translatedText: 'Bản trước', version: current.version },
      after: { ...current, translatedText: 'Bản đã lưu', version: current.version + 1 },
    };
    const committed = {
      ...state,
      project: {
        ...state.project,
        segments: state.project.segments.map((segment) => segment.id === current.id ? mutation.after : segment),
      },
      history: { past: [mutation], future: [] },
    };
    const canonical = { ...mutation.after, translatedText: 'Bản mới trên server', version: mutation.after.version + 4 };
    const h = harness(committed);
    h.services.persistUndo.mockRejectedValue(new SegmentVersionConflictError({
      id: canonical.id,
      projectId: committed.project.id,
      speakerId: canonical.speakerId === 'unassigned' ? null : canonical.speakerId,
      startMs: canonical.startMs,
      endMs: canonical.endMs,
      sourceText: canonical.sourceText,
      translatedText: canonical.translatedText,
      translationEngine: 'workers-ai',
      translationStatus: 'completed',
      voiceStatus: 'pending',
      version: canonical.version,
      splitParentId: null,
    }));

    await h.actions.undo();

    expect(h.services.persistUndo).toHaveBeenCalledWith(committed.project.id, mutation, committed.project);
    expect(h.dispatched).toEqual([
      { type: 'applyUndoLocal' },
      { type: 'applyRedoLocal' },
      { type: 'editDraft', segmentId: current.id, patch: { translatedText: 'Bản trước' } },
      { type: 'conflictDraftSave', segmentId: current.id, canonical },
    ]);
    expect(h.errors).toEqual(['']);
  });

  it('passes current canonical state to redo and reconciles a redone split to the fresh Worker child id', async () => {
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
      originalBefore: undone.project.segments.find((segment) => segment.id === originalBefore.id)!,
      leftAfter: { ...oldMutation.leftAfter, sourceText: 'left canonical', version: oldMutation.leftAfter.version + 5 },
      rightAfter: { ...oldMutation.rightAfter, id: 'child-new', sourceText: 'right canonical', version: oldMutation.rightAfter.version + 2 },
    };
    const h = harness(undone);
    h.services.persistRedo.mockResolvedValue(canonical);

    await h.actions.redo();

    expect(h.services.persistRedo).toHaveBeenCalledWith(undone.project.id, oldMutation, undone.project);
    expect(h.dispatched).toEqual([
      { type: 'applyRedoLocal' },
      { type: 'reconcileHistoryMutation', direction: 'redo', previous: oldMutation, mutation: canonical },
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
