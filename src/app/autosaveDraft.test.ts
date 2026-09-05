import { describe, expect, it } from 'vitest';
import type { Segment } from '../features/timeline/types';
import {
  beginDraftSave,
  commitDraftSave,
  conflictDraftSave,
  editDraft,
  failDraftSave,
  rebaseDraftForSafeReapply,
} from './autosaveDraft';

const base: Segment = {
  id: 's1', speakerId: 'sp1', startMs: 0, endMs: 1000,
  sourceText: 'hello', translatedText: 'xin chao', version: 3,
};

describe('autosave draft transitions', () => {
  it('moves clean -> dirty -> saving -> clean on a canonical save', () => {
    const dirty = editDraft(undefined, base, { translatedText: 'chao ban' });
    expect(dirty).toMatchObject({ phase: 'dirty', editRevision: 1, patch: { translatedText: 'chao ban' } });

    const saving = beginDraftSave(dirty);
    expect(saving).toMatchObject({ phase: 'saving', savingRevision: 1, savingPatch: { translatedText: 'chao ban' } });

    const canonical = { ...base, translatedText: 'chao ban', version: 4 };
    const committed = commitDraftSave(saving, canonical);
    expect(committed.draft).toBeUndefined();
    expect(committed.committedFields).toEqual(['translatedText']);
  });

  it('keeps only edits made while a request was in flight', () => {
    const saving = beginDraftSave(editDraft(undefined, base, { translatedText: 'first' }));
    const newer = editDraft(saving, base, { translatedText: 'second', sourceText: 'hello newer' });
    const canonical = { ...base, translatedText: 'first', version: 4 };
    const committed = commitDraftSave(newer, canonical);

    expect(committed.draft).toMatchObject({
      phase: 'dirty',
      base: canonical,
      patch: { translatedText: 'second', sourceText: 'hello newer' },
    });
    expect(committed.committedFields).toEqual(['translatedText']);
  });

  it('preserves a retryable patch on network failure', () => {
    const saving = beginDraftSave(editDraft(undefined, base, { sourceText: 'local' }));
    const failed = failDraftSave(saving, 'network down');
    expect(failed).toMatchObject({ phase: 'error', patch: { sourceText: 'local' }, error: 'network down' });
  });

  it('preserves local touched fields and canonical server state on conflict', () => {
    const saving = beginDraftSave(editDraft(undefined, base, { translatedText: 'local' }));
    const server = { ...base, translatedText: 'server', sourceText: 'server source', version: 7 };
    const conflicted = conflictDraftSave(saving, server);
    expect(conflicted).toMatchObject({
      phase: 'conflict',
      patch: { translatedText: 'local' },
      conflictingServer: server,
    });

    const reapplied = rebaseDraftForSafeReapply(conflicted);
    expect(reapplied).toMatchObject({
      phase: 'dirty',
      base: server,
      patch: { translatedText: 'local' },
    });
    expect(reapplied.patch).not.toHaveProperty('sourceText');
  });
});
