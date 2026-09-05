import { clampPixelsPerSecond } from '../features/timeline/math';
import type { Segment, StudioProject } from '../features/timeline/types';
import {
  beginDraftSave as beginSegmentDraftSave,
  commitDraftSave as commitSegmentDraftSave,
  conflictDraftSave as markSegmentDraftConflict,
  editDraft as editSegmentDraft,
  failDraftSave as failSegmentDraftSave,
  hasUnresolvedDraft,
  rebaseDraftForSafeReapply as rebaseSegmentDraftForSafeReapply,
  type SegmentDraft,
  type SegmentFieldPatch,
} from './autosaveDraft';
import {
  applyMutation,
  emptyEditorHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type EditorHistory,
  type FieldMutation,
  type SplitMutation,
  type TimingMutation,
} from './editorHistory';

export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

export type SegmentPreview = {
  segmentId: string;
  startMs: number;
  endMs: number;
};

export type StudioState = {
  project: StudioProject;
  selectedSegmentId: string;
  playheadMs: number;
  lipSyncEnabled: boolean;
  playback: {
    playing: boolean;
    rate: PlaybackRate;
    volume: number;
    muted: boolean;
  };
  timelineView: {
    pixelsPerSecond: number;
    scrollLeft: number;
    viewportWidth: number;
  };
  history: EditorHistory;
  drafts: Record<string, SegmentDraft>;
  segmentPreview: SegmentPreview | null;
};

export type StudioAction =
  | { type: 'selectSegment'; segmentId: string }
  | { type: 'setPlayhead'; playheadMs: number }
  | { type: 'editSource'; segmentId: string; text: string }
  | { type: 'editTranslation'; segmentId: string; text: string }
  | { type: 'assignSpeaker'; segmentId: string; speakerId: string }
  | { type: 'editDraft'; segmentId: string; patch: SegmentFieldPatch }
  | { type: 'beginDraftSave'; segmentId: string }
  | { type: 'commitDraftSave'; segmentId: string; canonical: Segment }
  | { type: 'failDraftSave'; segmentId: string; error: string }
  | { type: 'conflictDraftSave'; segmentId: string; canonical: Segment }
  | { type: 'discardDraftForServer'; segmentId: string }
  | { type: 'rebaseDraftForSafeReapply'; segmentId: string }
  | { type: 'hydrateProject'; project: StudioProject }
  | { type: 'toggleLipSync' }
  | { type: 'setPlaying'; playing: boolean }
  | { type: 'setPlaybackRate'; rate: PlaybackRate }
  | { type: 'setVolume'; volume: number }
  | { type: 'toggleMuted' }
  | { type: 'setTimelineZoom'; pixelsPerSecond: number }
  | { type: 'setTimelineScroll'; scrollLeft: number }
  | { type: 'setTimelineViewport'; viewportWidth: number }
  | { type: 'previewSegmentTiming'; segmentId: string; startMs: number; endMs: number }
  | { type: 'cancelSegmentPreview' }
  | { type: 'commitTimingMutation'; before: Segment; after: Segment }
  | { type: 'commitSplitMutation'; originalBefore: Segment; leftAfter: Segment; rightAfter: Segment }
  | { type: 'reconcileLatestSplitMutation'; previousRightId: string; mutation: SplitMutation }
  | { type: 'applyUndoLocal' }
  | { type: 'applyRedoLocal' };

export function createInitialStudioState(project: StudioProject): StudioState {
  const firstSegment = project.segments[0];
  return {
    project,
    selectedSegmentId: firstSegment?.id ?? '',
    playheadMs: firstSegment?.startMs ?? 0,
    lipSyncEnabled: true,
    playback: { playing: false, rate: 1, volume: 1, muted: false },
    timelineView: { pixelsPerSecond: 1, scrollLeft: 0, viewportWidth: 0 },
    history: emptyEditorHistory(),
    drafts: {},
    segmentPreview: null,
  };
}

function updateSegment(state: StudioState, segmentId: string, update: (segment: StudioProject['segments'][number]) => StudioProject['segments'][number]): StudioState {
  const segments = state.project.segments.map((segment) => segment.id === segmentId ? update(segment) : segment);
  return { ...state, project: { ...state.project, segments } };
}

function replaceProjectSegment(project: StudioProject, segmentId: string, replacement: Segment): StudioProject {
  return {
    ...project,
    segments: project.segments.map((segment) => segment.id === segmentId ? replacement : segment),
  };
}

function withDraft(state: StudioState, segmentId: string, draft: SegmentDraft | undefined): StudioState {
  const drafts = { ...state.drafts };
  if (draft) drafts[segmentId] = draft;
  else delete drafts[segmentId];
  return { ...state, drafts };
}

function selectionAfterMutation(state: StudioState, project: StudioProject, preferredId?: string): string {
  if (preferredId && project.segments.some((segment) => segment.id === preferredId)) return preferredId;
  if (project.segments.some((segment) => segment.id === state.selectedSegmentId)) return state.selectedSegmentId;
  return project.segments[0]?.id ?? '';
}

function hydrateWithoutOverwritingDraftBases(state: StudioState, incoming: StudioProject): StudioProject {
  const currentById = new Map(state.project.segments.map((segment) => [segment.id, segment]));
  const incomingIds = new Set(incoming.segments.map((segment) => segment.id));
  const segments = incoming.segments.map((segment) => {
    const draft = state.drafts[segment.id];
    const current = currentById.get(segment.id);
    return hasUnresolvedDraft(draft) && current ? current : segment;
  });
  for (const [segmentId, draft] of Object.entries(state.drafts)) {
    if (!hasUnresolvedDraft(draft) || incomingIds.has(segmentId)) continue;
    const current = currentById.get(segmentId);
    if (current) segments.push(current);
  }
  segments.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  return { ...incoming, segments };
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'selectSegment': {
      const segment = state.project.segments.find((item) => item.id === action.segmentId);
      return segment ? { ...state, selectedSegmentId: segment.id, playheadMs: segment.startMs } : state;
    }
    case 'setPlayhead':
      return { ...state, playheadMs: Math.max(0, Math.min(state.project.durationMs, action.playheadMs)) };
    case 'editSource':
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, sourceText: action.text }));
    case 'editTranslation':
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, translatedText: action.text }));
    case 'assignSpeaker':
      if (!state.project.speakers.some((speaker) => speaker.id === action.speakerId)) return state;
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, speakerId: action.speakerId }));
    case 'editDraft': {
      const canonical = state.project.segments.find((segment) => segment.id === action.segmentId);
      if (!canonical) return state;
      if (action.patch.speakerId !== undefined
        && !state.project.speakers.some((speaker) => speaker.id === action.patch.speakerId)) return state;
      return withDraft(
        state,
        action.segmentId,
        editSegmentDraft(state.drafts[action.segmentId], canonical, action.patch),
      );
    }
    case 'beginDraftSave': {
      const draft = state.drafts[action.segmentId];
      return draft ? withDraft(state, action.segmentId, beginSegmentDraftSave(draft)) : state;
    }
    case 'commitDraftSave': {
      const draft = state.drafts[action.segmentId];
      if (!draft) return { ...state, project: replaceProjectSegment(state.project, action.segmentId, action.canonical) };
      const result = commitSegmentDraftSave(draft, action.canonical);
      const project = replaceProjectSegment(state.project, action.segmentId, action.canonical);
      let history = state.history;
      if (result.committedFields.length > 0) {
        const mutation: FieldMutation = {
          kind: 'fields',
          segmentId: action.segmentId,
          fields: result.committedFields,
          before: draft.base,
          after: action.canonical,
        };
        history = pushHistory(history, mutation);
      }
      const next = withDraft({ ...state, project, history }, action.segmentId, result.draft);
      return { ...next, selectedSegmentId: selectionAfterMutation(state, project, action.segmentId) };
    }
    case 'failDraftSave': {
      const draft = state.drafts[action.segmentId];
      return draft ? withDraft(state, action.segmentId, failSegmentDraftSave(draft, action.error)) : state;
    }
    case 'conflictDraftSave': {
      const draft = state.drafts[action.segmentId];
      return draft ? withDraft(state, action.segmentId, markSegmentDraftConflict(draft, action.canonical)) : state;
    }
    case 'discardDraftForServer': {
      const draft = state.drafts[action.segmentId];
      if (!draft?.conflictingServer) return state;
      const project = replaceProjectSegment(state.project, action.segmentId, draft.conflictingServer);
      return withDraft({ ...state, project }, action.segmentId, undefined);
    }
    case 'rebaseDraftForSafeReapply': {
      const draft = state.drafts[action.segmentId];
      if (!draft?.conflictingServer) return state;
      const project = replaceProjectSegment(state.project, action.segmentId, draft.conflictingServer);
      const rebased = rebaseSegmentDraftForSafeReapply(draft);
      return withDraft({ ...state, project }, action.segmentId, hasUnresolvedDraft(rebased) ? rebased : undefined);
    }
    case 'hydrateProject': {
      const project = hydrateWithoutOverwritingDraftBases(state, action.project);
      const retained = project.segments.find((segment) => segment.id === state.selectedSegmentId);
      const selected = retained ?? project.segments[0];
      const retainedPlayhead = retained && state.playheadMs >= retained.startMs && state.playheadMs <= retained.endMs
        ? state.playheadMs
        : selected?.startMs ?? 0;
      return {
        ...state,
        project,
        selectedSegmentId: selected?.id ?? '',
        playheadMs: Math.max(0, Math.min(project.durationMs, retainedPlayhead)),
        playback: { ...state.playback, playing: false },
        history: emptyEditorHistory(),
        segmentPreview: null,
      };
    }
    case 'toggleLipSync':
      return { ...state, lipSyncEnabled: !state.lipSyncEnabled };
    case 'setPlaying':
      return { ...state, playback: { ...state.playback, playing: action.playing } };
    case 'setPlaybackRate':
      return { ...state, playback: { ...state.playback, rate: action.rate } };
    case 'setVolume':
      return { ...state, playback: { ...state.playback, volume: Math.max(0, Math.min(1, action.volume)) } };
    case 'toggleMuted':
      return { ...state, playback: { ...state.playback, muted: !state.playback.muted } };
    case 'setTimelineZoom':
      return { ...state, timelineView: { ...state.timelineView, pixelsPerSecond: clampPixelsPerSecond(action.pixelsPerSecond) } };
    case 'setTimelineScroll':
      return {
        ...state,
        timelineView: {
          ...state.timelineView,
          scrollLeft: Number.isFinite(action.scrollLeft) ? Math.max(0, action.scrollLeft) : 0,
        },
      };
    case 'setTimelineViewport':
      return {
        ...state,
        timelineView: {
          ...state.timelineView,
          viewportWidth: Number.isFinite(action.viewportWidth) ? Math.max(0, action.viewportWidth) : 0,
        },
      };
    case 'previewSegmentTiming':
      if (!state.project.segments.some((segment) => segment.id === action.segmentId)) return state;
      return {
        ...state,
        segmentPreview: {
          segmentId: action.segmentId,
          startMs: action.startMs,
          endMs: action.endMs,
        },
      };
    case 'cancelSegmentPreview':
      return state.segmentPreview ? { ...state, segmentPreview: null } : state;
    case 'commitTimingMutation': {
      if (action.before.id !== action.after.id) return { ...state, segmentPreview: null };
      const mutation: TimingMutation = {
        kind: 'timing',
        segmentId: action.before.id,
        before: action.before,
        after: action.after,
      };
      const project = applyMutation(state.project, mutation, 'forward');
      return {
        ...state,
        project,
        history: pushHistory(state.history, mutation),
        segmentPreview: null,
        selectedSegmentId: selectionAfterMutation(state, project, action.after.id),
      };
    }
    case 'commitSplitMutation': {
      const mutation: SplitMutation = {
        kind: 'split',
        originalBefore: action.originalBefore,
        leftAfter: action.leftAfter,
        rightAfter: action.rightAfter,
      };
      const project = applyMutation(state.project, mutation, 'forward');
      return {
        ...state,
        project,
        history: pushHistory(state.history, mutation),
        segmentPreview: null,
        selectedSegmentId: selectionAfterMutation(state, project, action.leftAfter.id),
      };
    }
    case 'reconcileLatestSplitMutation': {
      const latestIndex = state.history.past.length - 1;
      const latest = state.history.past[latestIndex];
      if (!latest || latest.kind !== 'split' || latest.rightAfter.id !== action.previousRightId) return state;
      if (action.mutation.originalBefore.id !== latest.originalBefore.id
        || action.mutation.leftAfter.id !== latest.leftAfter.id) return state;
      if (!state.project.segments.some((segment) => segment.id === action.previousRightId)
        || !state.project.segments.some((segment) => segment.id === action.mutation.leftAfter.id)) return state;
      if (action.mutation.rightAfter.id !== action.previousRightId
        && state.project.segments.some((segment) => segment.id === action.mutation.rightAfter.id)) return state;

      const segments = state.project.segments.map((segment) => {
        if (segment.id === action.mutation.leftAfter.id) return action.mutation.leftAfter;
        if (segment.id === action.previousRightId) return action.mutation.rightAfter;
        return segment;
      });
      const past = state.history.past.slice();
      past[latestIndex] = action.mutation;
      return {
        ...state,
        project: { ...state.project, segments },
        history: { ...state.history, past },
        selectedSegmentId: state.selectedSegmentId === action.previousRightId
          ? action.mutation.rightAfter.id
          : state.selectedSegmentId,
      };
    }
    case 'applyUndoLocal': {
      const step = undoHistory(state.history);
      if (!step.mutation) return state;
      const project = applyMutation(state.project, step.mutation, 'backward');
      const preferredId = step.mutation.kind === 'split' ? step.mutation.originalBefore.id : step.mutation.segmentId;
      return {
        ...state,
        project,
        history: step.history,
        segmentPreview: null,
        selectedSegmentId: selectionAfterMutation(state, project, preferredId),
      };
    }
    case 'applyRedoLocal': {
      const step = redoHistory(state.history);
      if (!step.mutation) return state;
      const project = applyMutation(state.project, step.mutation, 'forward');
      const preferredId = step.mutation.kind === 'split' ? step.mutation.leftAfter.id : step.mutation.segmentId;
      return {
        ...state,
        project,
        history: step.history,
        segmentPreview: null,
        selectedSegmentId: selectionAfterMutation(state, project, preferredId),
      };
    }
    default:
      return state;
  }
}
