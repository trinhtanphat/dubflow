import { useEffect, useRef } from 'react';
import type { Segment } from '../features/timeline/types';
import {
  persistEditorPatch,
} from '../features/transcript/editorPersistence';
import {
  SegmentVersionConflictError,
  type CloudSegment,
  type SegmentPatch,
} from '../features/transcript/segmentApi';
import {
  beginDraftSave,
  commitDraftSave,
  conflictDraftSave,
  editDraft,
  failDraftSave,
  hasUnresolvedDraft,
  rebaseDraftForSafeReapply,
  type SegmentDraft,
  type SegmentFieldPatch,
} from './autosaveDraft';
import {
  createSegmentAutosaveCoordinator,
  type SegmentAutosaveCoordinator,
} from './segmentAutosaveCoordinator';
import type { StudioAction, StudioState } from './studioState';

export type BeforeUnloadTarget = {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};

export function hasUnsavedWork(drafts: Record<string, SegmentDraft>): boolean {
  return Object.values(drafts).some((draft) => hasUnresolvedDraft(draft));
}

export function attachUnsavedWorkGuard(target: BeforeUnloadTarget, active: boolean): () => void {
  if (!active) return () => {};
  const handler = (event: any) => {
    event.preventDefault?.();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', handler);
  return () => target.removeEventListener('beforeunload', handler);
}

type PersistDraft = (
  projectId: string,
  segmentId: string,
  expectedVersion: number,
  patch: SegmentPatch,
) => Promise<CloudSegment>;

export type UseSegmentAutosaveOptions = {
  state: StudioState;
  dispatch: (action: StudioAction) => void;
  delayMs?: number;
  persist?: PersistDraft;
};

function toStudioSegment(segment: CloudSegment, fallbackSpeakerId: string): Segment {
  return {
    id: segment.id,
    speakerId: segment.speakerId?.trim() || fallbackSpeakerId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    version: segment.version,
  };
}

function toApiPatch(patch: SegmentFieldPatch): SegmentPatch {
  return {
    ...patch,
    ...(patch.speakerId === 'unassigned' ? { speakerId: null } : {}),
  };
}

function setMirrorDraft(
  drafts: Record<string, SegmentDraft>,
  segmentId: string,
  draft: SegmentDraft | undefined,
): Record<string, SegmentDraft> {
  const next = { ...drafts };
  if (draft) next[segmentId] = draft;
  else delete next[segmentId];
  return next;
}

export function useSegmentAutosave({
  state,
  dispatch,
  delayMs = 600,
  persist = persistEditorPatch,
}: UseSegmentAutosaveOptions) {
  const stateRef = useRef(state);
  const draftsRef = useRef(state.drafts);
  const persistRef = useRef(persist);
  const coordinatorRef = useRef<SegmentAutosaveCoordinator | null>(null);

  stateRef.current = state;
  draftsRef.current = state.drafts;
  persistRef.current = persist;

  if (!coordinatorRef.current) {
    coordinatorRef.current = createSegmentAutosaveCoordinator({
      delayMs,
      readDraft: (segmentId) => draftsRef.current[segmentId],
      persist: async (segmentId, draft) => {
        try {
          const cloud = await persistRef.current(
            stateRef.current.project.id,
            segmentId,
            draft.base.version,
            toApiPatch(draft.patch),
          );
          return toStudioSegment(cloud, draft.base.speakerId);
        } catch (error) {
          if (error instanceof SegmentVersionConflictError) {
            throw {
              code: 'SEGMENT_VERSION_CONFLICT' as const,
              canonical: toStudioSegment(error.canonical, draft.base.speakerId),
            };
          }
          throw error;
        }
      },
      onSaving: (segmentId) => {
        const current = draftsRef.current[segmentId];
        if (current) draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, beginDraftSave(current));
        dispatch({ type: 'beginDraftSave', segmentId });
      },
      onSuccess: (segmentId, canonical) => {
        const current = draftsRef.current[segmentId];
        if (current) {
          const result = commitDraftSave(current, canonical);
          draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, result.draft);
        }
        dispatch({ type: 'commitDraftSave', segmentId, canonical });
      },
      onError: (segmentId, error) => {
        const current = draftsRef.current[segmentId];
        const message = error instanceof Error && error.message ? error.message : 'Không thể lưu segment.';
        if (current) draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, failDraftSave(current, message));
        dispatch({ type: 'failDraftSave', segmentId, error: message });
      },
      onConflict: (segmentId, conflict) => {
        const current = draftsRef.current[segmentId];
        if (current) draftsRef.current = setMirrorDraft(
          draftsRef.current,
          segmentId,
          conflictDraftSave(current, conflict.canonical),
        );
        dispatch({ type: 'conflictDraftSave', segmentId, canonical: conflict.canonical });
      },
    });
  }

  useEffect(() => () => coordinatorRef.current?.dispose(), []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return attachUnsavedWorkGuard(window as unknown as BeforeUnloadTarget, hasUnsavedWork(state.drafts));
  }, [state.drafts]);

  const edit = (segmentId: string, patch: SegmentFieldPatch) => {
    const canonical = stateRef.current.project.segments.find((segment) => segment.id === segmentId);
    if (!canonical) return;
    if (patch.speakerId !== undefined
      && !stateRef.current.project.speakers.some((speaker) => speaker.id === patch.speakerId)) return;
    const next = editDraft(draftsRef.current[segmentId], canonical, patch);
    draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, next);
    dispatch({ type: 'editDraft', segmentId, patch });
    coordinatorRef.current?.schedule(segmentId);
  };

  const flush = (segmentId: string) => coordinatorRef.current?.flush(segmentId) ?? Promise.resolve();
  const retry = (segmentId: string) => coordinatorRef.current?.retry(segmentId) ?? Promise.resolve();

  const discardConflict = (segmentId: string) => {
    draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, undefined);
    dispatch({ type: 'discardDraftForServer', segmentId });
  };

  const reapplyConflict = async (segmentId: string) => {
    const current = draftsRef.current[segmentId];
    if (!current?.conflictingServer) return;
    const rebased = rebaseDraftForSafeReapply(current);
    draftsRef.current = setMirrorDraft(draftsRef.current, segmentId, hasUnresolvedDraft(rebased) ? rebased : undefined);
    dispatch({ type: 'rebaseDraftForSafeReapply', segmentId });
    if (hasUnresolvedDraft(rebased)) await (coordinatorRef.current?.retry(segmentId) ?? Promise.resolve());
  };

  return {
    edit,
    flush,
    retry,
    discardConflict,
    reapplyConflict,
    hasUnsavedWork: hasUnsavedWork(state.drafts),
  };
}
