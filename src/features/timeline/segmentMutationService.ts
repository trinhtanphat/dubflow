import type {
  EditorMutation,
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
import type { Segment } from './types';

const UNASSIGNED_SPEAKER_ID = 'unassigned';

export type SegmentMutationDeps = {
  patchSegment: (projectId: string, segmentId: string, patch: SegmentPatch) => Promise<CloudSegment>;
  splitSegment: (projectId: string, segmentId: string, playheadMs: number) => Promise<{ left: CloudSegment; right: CloudSegment }>;
  restoreSplit: (
    projectId: string,
    segmentId: string,
    childSegmentId: string,
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

export async function commitSegmentTiming(
  projectId: string,
  before: Segment,
  timing: Pick<Segment, 'startMs' | 'endMs'>,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<TimingMutation> {
  const persisted = await deps.patchSegment(projectId, before.id, timing);
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
  const persisted = await deps.splitSegment(projectId, originalBefore.id, playheadMs);
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
  deps: SegmentMutationDeps = defaultDeps,
): Promise<EditorMutation> {
  if (mutation.kind === 'timing') {
    await deps.patchSegment(projectId, mutation.segmentId, {
      startMs: mutation.before.startMs,
      endMs: mutation.before.endMs,
    });
    return mutation;
  }

  await deps.restoreSplit(
    projectId,
    mutation.originalBefore.id,
    mutation.rightAfter.id,
    toRestoreInput(mutation.originalBefore),
  );
  return mutation;
}

export async function persistRedo(
  projectId: string,
  mutation: EditorMutation,
  deps: SegmentMutationDeps = defaultDeps,
): Promise<EditorMutation> {
  if (mutation.kind === 'timing') {
    await deps.patchSegment(projectId, mutation.segmentId, {
      startMs: mutation.after.startMs,
      endMs: mutation.after.endMs,
    });
    return mutation;
  }

  return commitSegmentSplit(
    projectId,
    mutation.originalBefore,
    mutation.leftAfter.endMs,
    deps,
  );
}
