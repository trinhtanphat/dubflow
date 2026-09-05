import type { Segment, StudioProject } from '../features/timeline/types';
import type { SegmentField } from './autosaveDraft';

export const HISTORY_LIMIT = 100;

export type FieldMutation = {
  kind: 'fields';
  segmentId: string;
  fields: SegmentField[];
  before: Segment;
  after: Segment;
};

export type TimingMutation = {
  kind: 'timing';
  segmentId: string;
  before: Segment;
  after: Segment;
};

export type SplitMutation = {
  kind: 'split';
  originalBefore: Segment;
  leftAfter: Segment;
  rightAfter: Segment;
};

export type EditorMutation = FieldMutation | TimingMutation | SplitMutation;
export type EditorHistory = { past: EditorMutation[]; future: EditorMutation[] };
export type HistoryStep = { history: EditorHistory; mutation: EditorMutation | null };

export const emptyEditorHistory = (): EditorHistory => ({ past: [], future: [] });

function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
}

export function pushHistory(history: EditorHistory, mutation: EditorMutation): EditorHistory {
  return {
    past: [...history.past, mutation].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export function undoHistory(history: EditorHistory): HistoryStep {
  const mutation = history.past.at(-1) ?? null;
  if (!mutation) return { history, mutation: null };
  return {
    mutation,
    history: {
      past: history.past.slice(0, -1),
      future: [mutation, ...history.future],
    },
  };
}

export function redoHistory(history: EditorHistory): HistoryStep {
  const mutation = history.future[0] ?? null;
  if (!mutation) return { history, mutation: null };
  return {
    mutation,
    history: {
      past: [...history.past, mutation].slice(-HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}

export function applyMutation(
  project: StudioProject,
  mutation: EditorMutation,
  direction: 'forward' | 'backward',
): StudioProject {
  if (mutation.kind === 'fields') {
    const source = direction === 'forward' ? mutation.after : mutation.before;
    return {
      ...project,
      segments: project.segments.map((segment) => {
        if (segment.id !== mutation.segmentId) return segment;
        const next = { ...segment };
        for (const field of mutation.fields) {
          if (field === 'sourceText') next.sourceText = source.sourceText;
          else if (field === 'translatedText') next.translatedText = source.translatedText;
          else next.speakerId = source.speakerId;
        }
        return next;
      }),
    };
  }

  if (mutation.kind === 'timing') {
    const replacement = direction === 'forward' ? mutation.after : mutation.before;
    return {
      ...project,
      segments: project.segments.map((segment) => segment.id === mutation.segmentId ? replacement : segment),
    };
  }

  if (direction === 'forward') {
    const segments = project.segments
      .filter((segment) => segment.id !== mutation.rightAfter.id)
      .map((segment) => segment.id === mutation.originalBefore.id ? mutation.leftAfter : segment);
    return { ...project, segments: sortSegments([...segments, mutation.rightAfter]) };
  }

  const segments = project.segments
    .filter((segment) => segment.id !== mutation.rightAfter.id)
    .map((segment) => segment.id === mutation.originalBefore.id ? mutation.originalBefore : segment);
  return { ...project, segments: sortSegments(segments) };
}
