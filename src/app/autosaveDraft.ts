import type { Segment } from '../features/timeline/types';

export type SegmentFieldPatch = Partial<Pick<Segment, 'sourceText' | 'translatedText' | 'speakerId'>>;
export type SegmentField = keyof SegmentFieldPatch;
export type DraftPhase = 'dirty' | 'saving' | 'error' | 'conflict';

export type SegmentDraft = {
  base: Segment;
  patch: SegmentFieldPatch;
  phase: DraftPhase;
  editRevision: number;
  savingRevision?: number;
  savingPatch?: SegmentFieldPatch;
  error?: string;
  conflictingServer?: Segment;
};

export type DraftCommitResult = {
  draft?: SegmentDraft;
  committedFields: SegmentField[];
};

const FIELD_KEYS: SegmentField[] = ['sourceText', 'translatedText', 'speakerId'];

export function segmentFieldKeys(patch: SegmentFieldPatch): SegmentField[] {
  return FIELD_KEYS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

export function applySegmentFieldPatch(segment: Segment, patch: SegmentFieldPatch): Segment {
  return { ...segment, ...patch };
}

function normalizedPatch(base: Segment, patch: SegmentFieldPatch): SegmentFieldPatch {
  const next: SegmentFieldPatch = {};
  for (const field of segmentFieldKeys(patch)) {
    const value = patch[field];
    if (value !== base[field]) (next as Record<string, unknown>)[field] = value;
  }
  return next;
}

export function editDraft(current: SegmentDraft | undefined, base: Segment, patch: SegmentFieldPatch): SegmentDraft {
  const draftBase = current?.base ?? base;
  const merged = normalizedPatch(draftBase, { ...(current?.patch ?? {}), ...patch });
  const requestInFlight = current?.savingRevision !== undefined;
  return {
    base: draftBase,
    patch: merged,
    phase: requestInFlight ? 'saving' : 'dirty',
    editRevision: (current?.editRevision ?? 0) + 1,
    savingRevision: current?.savingRevision,
    savingPatch: current?.savingPatch,
  };
}

export function beginDraftSave(draft: SegmentDraft): SegmentDraft {
  return {
    ...draft,
    phase: 'saving',
    savingRevision: draft.editRevision,
    savingPatch: { ...draft.patch },
    error: undefined,
    conflictingServer: undefined,
  };
}

export function commitDraftSave(draft: SegmentDraft, canonical: Segment): DraftCommitResult {
  const submitted = draft.savingPatch ?? {};
  const committedFields = segmentFieldKeys(submitted);
  const residual: SegmentFieldPatch = {};
  for (const field of segmentFieldKeys(draft.patch)) {
    const currentValue = draft.patch[field];
    const submittedHadField = Object.prototype.hasOwnProperty.call(submitted, field);
    const submittedValue = submitted[field];
    if (!submittedHadField || currentValue !== submittedValue) {
      (residual as Record<string, unknown>)[field] = currentValue;
    }
  }
  const normalizedResidual = normalizedPatch(canonical, residual);
  if (segmentFieldKeys(normalizedResidual).length === 0) return { committedFields };
  return {
    committedFields,
    draft: {
      base: canonical,
      patch: normalizedResidual,
      phase: 'dirty',
      editRevision: draft.editRevision,
    },
  };
}

export function failDraftSave(draft: SegmentDraft, error: string): SegmentDraft {
  return {
    ...draft,
    phase: 'error',
    savingRevision: undefined,
    savingPatch: undefined,
    error,
    conflictingServer: undefined,
  };
}

export function conflictDraftSave(draft: SegmentDraft, canonical: Segment): SegmentDraft {
  return {
    ...draft,
    phase: 'conflict',
    savingRevision: undefined,
    savingPatch: undefined,
    error: undefined,
    conflictingServer: canonical,
  };
}

export function rebaseDraftForSafeReapply(draft: SegmentDraft): SegmentDraft {
  if (!draft.conflictingServer) return draft;
  const base = draft.conflictingServer;
  return {
    base,
    patch: normalizedPatch(base, draft.patch),
    phase: 'dirty',
    editRevision: draft.editRevision + 1,
  };
}

export function hasUnresolvedDraft(draft: SegmentDraft | undefined): boolean {
  return Boolean(draft && segmentFieldKeys(draft.patch).length > 0);
}
