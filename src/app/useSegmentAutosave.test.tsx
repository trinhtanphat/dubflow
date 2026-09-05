import { describe, expect, it, vi } from 'vitest';
import type { Segment } from '../features/timeline/types';
import { beginDraftSave, conflictDraftSave, editDraft, failDraftSave } from './autosaveDraft';
import { attachUnsavedWorkGuard, hasUnsavedWork } from './useSegmentAutosave';

const base: Segment = {
  id: 's1', speakerId: 'sp1', startMs: 0, endMs: 1000,
  sourceText: 'hello', translatedText: 'xin chao', version: 1,
};

describe('unsaved work guard', () => {
  it('treats dirty, saving, error and conflict drafts as unresolved work', () => {
    const dirty = editDraft(undefined, base, { translatedText: 'local' });
    const saving = beginDraftSave(dirty);
    const error = failDraftSave(saving, 'network');
    const conflict = conflictDraftSave(saving, { ...base, translatedText: 'server', version: 2 });

    expect(hasUnsavedWork({})).toBe(false);
    expect(hasUnsavedWork({ s1: dirty })).toBe(true);
    expect(hasUnsavedWork({ s1: saving })).toBe(true);
    expect(hasUnsavedWork({ s1: error })).toBe(true);
    expect(hasUnsavedWork({ s1: conflict })).toBe(true);
  });

  it('registers beforeunload only while unresolved work exists and removes it on cleanup', () => {
    let handler: ((event: any) => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: string, listener: (event: any) => void) => { handler = listener; }),
      removeEventListener: vi.fn((_type: string, listener: (event: any) => void) => {
        if (handler === listener) handler = undefined;
      }),
    };

    const clean = attachUnsavedWorkGuard(target, false);
    expect(target.addEventListener).not.toHaveBeenCalled();
    clean();

    const cleanup = attachUnsavedWorkGuard(target, true);
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    handler?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe('');

    cleanup();
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(handler).toBeUndefined();
  });
});
