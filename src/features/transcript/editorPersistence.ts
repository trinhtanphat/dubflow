import { patchSegment, type CloudSegment, type SegmentPatch } from './segmentApi';
import { retranslateSegment, type RetranslateResult, type TranslationMode } from '../translation/translationApi';

export type EditorPatchDeps = {
  patchSegment: (projectId: string, segmentId: string, expectedVersion: number, patch: SegmentPatch) => Promise<CloudSegment>;
};

export type EditorRetranslateDeps = {
  retranslateSegment: (projectId: string, segmentId: string, expectedVersion: number, mode: TranslationMode) => Promise<RetranslateResult>;
};

export type EditorRetranslateResult =
  | { mode: 'compare'; workersAI: string; google: string }
  | { mode: 'persisted'; segment: CloudSegment };

export class EditorPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorPersistenceError';
  }
}

const defaultPatchDeps: EditorPatchDeps = { patchSegment };
const defaultRetranslateDeps: EditorRetranslateDeps = { retranslateSegment };

export function persistEditorPatch(
  projectId: string,
  segmentId: string,
  expectedVersion: number,
  patch: SegmentPatch,
  deps: EditorPatchDeps = defaultPatchDeps,
) {
  return deps.patchSegment(projectId, segmentId, expectedVersion, patch);
}

export async function retranslateEditorSegment(
  projectId: string,
  segmentId: string,
  expectedVersion: number,
  mode: TranslationMode,
  deps: EditorRetranslateDeps = defaultRetranslateDeps,
): Promise<EditorRetranslateResult> {
  const result = await deps.retranslateSegment(projectId, segmentId, expectedVersion, mode);
  if (result.mode === 'compare') {
    const workersAI = result.workersAI[0]?.text;
    const google = result.google[0]?.text;
    if (workersAI === undefined || google === undefined) throw new EditorPersistenceError('Translation compare returned incomplete choices.');
    return { mode: 'compare', workersAI, google };
  }
  if (!result.segment) throw new EditorPersistenceError('Translation completed without a persisted segment.');
  return { mode: 'persisted', segment: result.segment };
}
