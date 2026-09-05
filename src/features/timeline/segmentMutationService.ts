import type {
  EditorMutation,
  FieldMutation,
  SplitMutation,
  TimingMutation,
} from '../../app/editorHistory';
import {
  patchSegment,
  restoreSplit,
  splitSegment,
  type CloudSegment,
  type RestoreSegmentInput,
  type SegmentPatch,
} from '../transcript/segmentApi';
import type { Segment, StudioProject } from './types';

const UNASSIGNED_SPEAKER_ID = 'unassigned';

export type SegmentMutationDeps = {
  patchSegment: (projectId: string, segmentId: string, expectedVersion: number, patch: SegmentPatch) => Promise<CloudSegment>;
  splitSegment: (projectId: string, segmentId: string, expectedVersion: number, playheadMs: number) => Promise<{ left: CloudSegment; right: CloudSegment }>;
  restoreSplit: (
    projectId: string,
    segmentId: string,
    expectedVersion: number,
    childSegmentId: string,
    expectedChildVersion: number,
    original: RestoreSegmentInput,
  ) => Promise<CloudSegment>;
};

const defaultDeps: SegmentMutationDeps = { patchSegment, splitSegment, restoreSplit };

function toStudioSegment(segment: CloudSegment, fallbackSpeakerId = UNASSIGNED_SPEAKER_ID): Segment {
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

function toRestoreInput(segment: Segment): RestoreSegmentInput {
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    speakerId: segment.speakerId === UNASSIGNED_SPEAKER_ID ? null : segment.speakerId,
  };
}

function requireCurrentSegment(project: StudioProject, segmentId: string): Segment {
  const segment = project.segments.find((item) => item.id === segmentId);
  if (!segment) throw new Error(`Current canonical segment not found: ${segmentId}`);
  return segment;
}

function fieldPatch(mutation: FieldMutation, direction: 'undo' | 'redo'): SegmentPatch {
  const source = direction === 'undo' ? mutation.before : mutation.after;
  const patch: SegmentPatch = {};
  for (const field of mutation.fields) {
    if (field === 'sourceText') patch.sourceText = source.sourceText;
    else if (field === 'translatedText') patch.translatedText = source.translatedText;
    else patch.speakerId = source.speakerId === UNASSIGNED_SPEAKER_ID ? null : source.speakerId;
  }
  return patch;
}

export async function commitSegmentTiming(
  projectId: string,
  before: Segment,
  timing: Pick<Segment, 'startMs' | 'endMs'>,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<TimingMutation> {
  const persisted = await deps.patchSegment(projectId, before.id, before.version, timing);
  return {
    kind: 'timing',
    segmentId: before.id,
    before,
    after: toStudioSegment(persisted, before.speakerId),
  };
}

export async function commitSegmentSplit(
  projectId: string,
  originalBefore: Segment,
  playheadMs: number,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<SplitMutation> {
  const persisted = await deps.splitSegment(projectId, originalBefore.id, originalBefore.version, playheadMs);
  return {
    kind: 'split',
    originalBefore,
    leftAfter: toStudioSegment(persisted.left, originalBefore.speakerId),
    rightAfter: toStudioSegment(persisted.right, originalBefore.speakerId),
  };
}

export async function persistUndo(
  projectId: string,
  mutation: EditorMutation,
  currentProject: StudioProject,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<EditorMutation> {
  if (mutation.kind === 'fields') {
    const current = requireCurrentSegment(currentProject, mutation.segmentId);
    const persisted = await deps.patchSegment(projectId, mutation.segmentId, current.version, fieldPatch(mutation, 'undo'));
    const canonical = toStudioSegment(persisted, current.speakerId);
    return { ...mutation, before: canonical, after: current };
  }

  if (mutation.kind === 'timing') {
    const current = requireCurrentSegment(currentProject, mutation.segmentId);
    const persisted = await deps.patchSegment(projectId, mutation.segmentId, current.version, {
      startMs: mutation.before.startMs,
      endMs: mutation.before.endMs,
    });
    return {
      kind: 'timing',
      segmentId: mutation.segmentId,
      before: toStudioSegment(persisted, current.speakerId),
      after: current,
    };
  }

  const currentParent = requireCurrentSegment(currentProject, mutation.originalBefore.id);
  const currentChild = requireCurrentSegment(currentProject, mutation.rightAfter.id);
  const persisted = await deps.restoreSplit(
    projectId,
    currentParent.id,
    currentParent.version,
    currentChild.id,
    currentChild.version,
    toRestoreInput(mutation.originalBefore),
  );
  return {
    kind: 'split',
    originalBefore: toStudioSegment(persisted, currentParent.speakerId),
    leftAfter: currentParent,
    rightAfter: currentChild,
  };
}

export async function persistRedo(
  projectId: string,
  mutation: EditorMutation,
  currentProject: StudioProject,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<EditorMutation> {
  if (mutation.kind === 'fields') {
    const current = requireCurrentSegment(currentProject, mutation.segmentId);
    const persisted = await deps.patchSegment(projectId, mutation.segmentId, current.version, fieldPatch(mutation, 'redo'));
    const canonical = toStudioSegment(persisted, current.speakerId);
    return { ...mutation, before: current, after: canonical };
  }

  if (mutation.kind === 'timing') {
    const current = requireCurrentSegment(currentProject, mutation.segmentId);
    const persisted = await deps.patchSegment(projectId, mutation.segmentId, current.version, {
      startMs: mutation.after.startMs,
      endMs: mutation.after.endMs,
    });
    return {
      kind: 'timing',
      segmentId: mutation.segmentId,
      before: current,
      after: toStudioSegment(persisted, current.speakerId),
    };
  }

  const currentParent = requireCurrentSegment(currentProject, mutation.originalBefore.id);
  return commitSegmentSplit(
    projectId,
    currentParent,
    mutation.leftAfter.endMs,
    deps,
  );
}
