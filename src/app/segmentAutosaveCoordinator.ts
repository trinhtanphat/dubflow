import type { Segment } from '../features/timeline/types';
import type { SegmentDraft } from './autosaveDraft';

type VersionConflict = {
  code: 'SEGMENT_VERSION_CONFLICT';
  canonical: Segment;
};

export type SegmentAutosaveCoordinatorOptions = {
  delayMs: number;
  readDraft: (segmentId: string) => SegmentDraft | undefined;
  persist: (segmentId: string, draft: SegmentDraft) => Promise<Segment>;
  onSaving: (segmentId: string, draft: SegmentDraft) => void;
  onSuccess: (segmentId: string, canonical: Segment) => void;
  onError: (segmentId: string, error: unknown) => void;
  onConflict: (segmentId: string, conflict: VersionConflict) => void;
};

export type SegmentAutosaveCoordinator = {
  schedule(segmentId: string): void;
  flush(segmentId: string): Promise<void>;
  retry(segmentId: string): Promise<void>;
  dispose(): void;
};

function isVersionConflict(error: unknown): error is VersionConflict {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const value = error as Record<string, unknown>;
  return value.code === 'SEGMENT_VERSION_CONFLICT'
    && Boolean(value.canonical)
    && typeof value.canonical === 'object';
}

export function createSegmentAutosaveCoordinator(
  options: SegmentAutosaveCoordinatorOptions,
): SegmentAutosaveCoordinator {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();
  const pendingAfterFlight = new Set<string>();
  let disposed = false;

  const clearTimer = (segmentId: string) => {
    const timer = timers.get(segmentId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(segmentId);
  };

  const canStart = (draft: SegmentDraft | undefined, allowError = false) => {
    if (!draft) return false;
    return draft.phase === 'dirty' || (allowError && draft.phase === 'error');
  };

  const runSave = (segmentId: string, allowError = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    const existing = inFlight.get(segmentId);
    if (existing) {
      pendingAfterFlight.add(segmentId);
      return existing;
    }

    const draft = options.readDraft(segmentId);
    if (!canStart(draft, allowError)) return Promise.resolve();
    clearTimer(segmentId);
    options.onSaving(segmentId, draft!);

    const task = options.persist(segmentId, draft!)
      .then((canonical) => {
        options.onSuccess(segmentId, canonical);
      })
      .catch((error: unknown) => {
        pendingAfterFlight.delete(segmentId);
        if (isVersionConflict(error)) options.onConflict(segmentId, error);
        else options.onError(segmentId, error);
      })
      .finally(() => {
        inFlight.delete(segmentId);
        if (disposed) return;
        if (!pendingAfterFlight.delete(segmentId)) return;
        setTimeout(() => {
          if (disposed) return;
          if (options.readDraft(segmentId)?.phase === 'dirty') void runSave(segmentId);
        }, 0);
      });
    inFlight.set(segmentId, task);
    return task;
  };

  return {
    schedule(segmentId) {
      if (disposed) return;
      if (inFlight.has(segmentId)) {
        pendingAfterFlight.add(segmentId);
        return;
      }
      if (options.readDraft(segmentId)?.phase !== 'dirty') return;
      clearTimer(segmentId);
      timers.set(segmentId, setTimeout(() => {
        timers.delete(segmentId);
        void runSave(segmentId);
      }, options.delayMs));
    },
    flush(segmentId) {
      if (disposed) return Promise.resolve();
      clearTimer(segmentId);
      if (inFlight.has(segmentId)) {
        pendingAfterFlight.add(segmentId);
        return inFlight.get(segmentId)!;
      }
      return runSave(segmentId);
    },
    retry(segmentId) {
      if (disposed) return Promise.resolve();
      clearTimer(segmentId);
      if (inFlight.has(segmentId)) {
        pendingAfterFlight.add(segmentId);
        return inFlight.get(segmentId)!;
      }
      return runSave(segmentId, true);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pendingAfterFlight.clear();
    },
  };
}
