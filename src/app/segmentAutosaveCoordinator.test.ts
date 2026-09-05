import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Segment } from '../features/timeline/types';
import {
  beginDraftSave,
  commitDraftSave,
  conflictDraftSave,
  editDraft,
  failDraftSave,
  rebaseDraftForSafeReapply,
  type SegmentDraft,
} from './autosaveDraft';
import { createSegmentAutosaveCoordinator } from './segmentAutosaveCoordinator';

const base: Segment = {
  id: 's1', speakerId: 'sp1', startMs: 0, endMs: 1000,
  sourceText: 'hello', translatedText: 'xin chao', version: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

function makeHarness(persistImpl?: (draft: SegmentDraft) => Promise<Segment>) {
  let draft: SegmentDraft | undefined;
  const calls: SegmentDraft[] = [];
  const errors: unknown[] = [];
  const conflicts: unknown[] = [];
  const persist = persistImpl ?? (async (submitted: SegmentDraft) => ({ ...base, ...submitted.patch, version: submitted.base.version + 1 }));
  const coordinator = createSegmentAutosaveCoordinator({
    delayMs: 600,
    readDraft: () => draft,
    persist: async (_segmentId, submitted) => {
      calls.push(submitted);
      return persist(submitted);
    },
    onSaving: () => { if (draft) draft = beginDraftSave(draft); },
    onSuccess: (_segmentId, canonical) => {
      if (!draft) return;
      draft = commitDraftSave(draft, canonical).draft;
    },
    onError: (_segmentId, error) => {
      errors.push(error);
      if (draft) draft = failDraftSave(draft, error instanceof Error ? error.message : 'save failed');
    },
    onConflict: (_segmentId, error) => {
      conflicts.push(error);
      const canonical = (error as any).canonical as Segment;
      if (draft && canonical) draft = conflictDraftSave(draft, canonical);
    },
  });
  return {
    coordinator,
    calls,
    errors,
    conflicts,
    getDraft: () => draft,
    edit(patch: Parameters<typeof editDraft>[2]) {
      draft = editDraft(draft, base, patch);
      coordinator.schedule(base.id);
    },
    setDraft(value: SegmentDraft | undefined) { draft = value; },
  };
}

describe('segment autosave coordinator', () => {
  it('coalesces three edits inside 600 ms into one write', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.edit({ translatedText: 'a' });
    await vi.advanceTimersByTimeAsync(200);
    h.edit({ translatedText: 'ab' });
    await vi.advanceTimersByTimeAsync(200);
    h.edit({ translatedText: 'abc' });
    await vi.advanceTimersByTimeAsync(599);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.patch).toEqual({ translatedText: 'abc' });
  });

  it('flushes immediately and never overlaps requests for the same segment', async () => {
    vi.useFakeTimers();
    let releaseFirst!: (value: Segment) => void;
    const first = new Promise<Segment>((resolve) => { releaseFirst = resolve; });
    let invocation = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const h = makeHarness(async (submitted) => {
      invocation += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (invocation === 1) {
        const result = await first;
        concurrent -= 1;
        return result;
      }
      concurrent -= 1;
      return { ...base, ...submitted.patch, version: 3 };
    });

    h.edit({ translatedText: 'first' });
    const flushing = h.coordinator.flush(base.id);
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);

    h.edit({ translatedText: 'second' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(1);
    expect(maxConcurrent).toBe(1);

    releaseFirst({ ...base, translatedText: 'first', version: 2 });
    await flushing;
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(2);
    expect(maxConcurrent).toBe(1);
  });

  it('does not loop on network error and retries only on explicit retry', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = makeHarness(async (submitted) => {
      attempts += 1;
      if (attempts === 1) throw new Error('network down');
      return { ...base, ...submitted.patch, version: 2 };
    });
    h.edit({ sourceText: 'local' });
    await vi.advanceTimersByTimeAsync(600);
    expect(attempts).toBe(1);
    expect(h.getDraft()?.phase).toBe('error');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);

    await h.coordinator.retry(base.id);
    expect(attempts).toBe(2);
  });

  it('stops on version conflict until the draft is explicitly rebased', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const server = { ...base, translatedText: 'server', version: 5 };
    const h = makeHarness(async (submitted) => {
      attempts += 1;
      if (attempts === 1) throw { name: 'SegmentVersionConflictError', code: 'SEGMENT_VERSION_CONFLICT', canonical: server };
      return { ...server, ...submitted.patch, version: 6 };
    });
    h.edit({ translatedText: 'mine' });
    await vi.advanceTimersByTimeAsync(600);
    expect(attempts).toBe(1);
    expect(h.getDraft()?.phase).toBe('conflict');
    expect(h.conflicts).toHaveLength(1);

    h.edit({ sourceText: 'must not autosave during conflict' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(1);
    await h.coordinator.retry(base.id);
    expect(attempts).toBe(1);

    const conflicted = h.getDraft();
    if (!conflicted) throw new Error('expected conflict draft');
    h.setDraft(rebaseDraftForSafeReapply(conflicted));
    await h.coordinator.retry(base.id);
    expect(attempts).toBe(2);
  });
});
