import { describe, expect, it } from 'vitest';
import type { StudioProject } from '../features/timeline/types';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer } from './studioState';

function reduce(state: ReturnType<typeof createInitialStudioState>, action: unknown) {
  return studioReducer(state, action as any);
}

describe('studio V2.5 draft state', () => {
  it('keeps canonical segment unchanged while edits live in a dirty draft', () => {
    const initial = createInitialStudioState(mockProject);
    const canonical = initial.project.segments[0]!;
    const next = reduce(initial, {
      type: 'editDraft', segmentId: canonical.id, patch: { translatedText: 'local draft' },
    });
    expect(next.project.segments[0]).toEqual(canonical);
    expect((next as any).drafts[canonical.id]).toMatchObject({
      phase: 'dirty', patch: { translatedText: 'local draft' }, base: canonical,
    });
  });

  it('commits one field history item only after a canonical save succeeds', () => {
    const initial = createInitialStudioState(mockProject);
    const canonical = initial.project.segments[0]!;
    let state = reduce(initial, { type: 'editDraft', segmentId: canonical.id, patch: { translatedText: 'saved text' } });
    expect(state.history.past).toHaveLength(0);
    state = reduce(state, { type: 'beginDraftSave', segmentId: canonical.id });
    const server = { ...canonical, translatedText: 'saved text', version: canonical.version + 1 };
    state = reduce(state, { type: 'commitDraftSave', segmentId: canonical.id, canonical: server });
    expect(state.project.segments[0]).toEqual(server);
    expect((state as any).drafts[canonical.id]).toBeUndefined();
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0]).toMatchObject({ kind: 'fields', fields: ['translatedText'] });
  });

  it('preserves a newer local edit after an older in-flight save succeeds', () => {
    const initial = createInitialStudioState(mockProject);
    const canonical = initial.project.segments[0]!;
    let state = reduce(initial, { type: 'editDraft', segmentId: canonical.id, patch: { translatedText: 'first' } });
    state = reduce(state, { type: 'beginDraftSave', segmentId: canonical.id });
    state = reduce(state, { type: 'editDraft', segmentId: canonical.id, patch: { translatedText: 'second' } });
    const server = { ...canonical, translatedText: 'first', version: canonical.version + 1 };
    state = reduce(state, { type: 'commitDraftSave', segmentId: canonical.id, canonical: server });
    expect(state.project.segments[0]).toEqual(server);
    expect((state as any).drafts[canonical.id]).toMatchObject({ phase: 'dirty', base: server, patch: { translatedText: 'second' } });
  });

  it('keeps local patch and server canonical visible in conflict, then supports both policy-A resolutions', () => {
    const initial = createInitialStudioState(mockProject);
    const canonical = initial.project.segments[0]!;
    const server = { ...canonical, translatedText: 'server text', version: canonical.version + 3 };
    let conflicted = reduce(initial, { type: 'editDraft', segmentId: canonical.id, patch: { translatedText: 'my text' } });
    conflicted = reduce(conflicted, { type: 'beginDraftSave', segmentId: canonical.id });
    conflicted = reduce(conflicted, { type: 'conflictDraftSave', segmentId: canonical.id, canonical: server });
    expect((conflicted as any).drafts[canonical.id]).toMatchObject({
      phase: 'conflict', patch: { translatedText: 'my text' }, conflictingServer: server,
    });

    const discarded = reduce(conflicted, { type: 'discardDraftForServer', segmentId: canonical.id });
    expect(discarded.project.segments[0]).toEqual(server);
    expect((discarded as any).drafts[canonical.id]).toBeUndefined();

    const reapplied = reduce(conflicted, { type: 'rebaseDraftForSafeReapply', segmentId: canonical.id });
    expect(reapplied.project.segments[0]).toEqual(server);
    expect((reapplied as any).drafts[canonical.id]).toMatchObject({
      phase: 'dirty', base: server, patch: { translatedText: 'my text' },
    });
  });

  it('does not silently replace the canonical base for a segment with unresolved local work during hydration', () => {
    const initial = createInitialStudioState(mockProject);
    const canonical = initial.project.segments[0]!;
    let state = reduce(initial, { type: 'editDraft', segmentId: canonical.id, patch: { sourceText: 'unsaved local' } });
    const incoming: StudioProject = {
      ...mockProject,
      title: 'hydrated',
      segments: mockProject.segments.map((segment) => segment.id === canonical.id
        ? { ...segment, sourceText: 'new server source', version: segment.version + 5 }
        : segment),
    };
    state = reduce(state, { type: 'hydrateProject', project: incoming });
    expect(state.project.title).toBe('hydrated');
    expect(state.project.segments.find((segment) => segment.id === canonical.id)).toEqual(canonical);
    expect((state as any).drafts[canonical.id]).toMatchObject({ patch: { sourceText: 'unsaved local' } });
  });
});
