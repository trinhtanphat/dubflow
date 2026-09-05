import { describe, expect, it } from 'vitest';
import { resolveStudioShortcut, type StudioShortcutInput } from './shortcuts';

const baseContext = {
  typing: false,
  timelineFocused: false,
  canUndo: true,
  canRedo: true,
  canSplit: true,
};

function shortcut(key: string, patch: Partial<StudioShortcutInput> = {}) {
  return resolveStudioShortcut({ key, ...patch }, baseContext);
}

describe('Studio V2 keyboard shortcuts', () => {
  it('opens the command palette with Ctrl/Cmd+K', () => {
    expect(shortcut('k', { ctrlKey: true })).toBe('open-commands');
    expect(shortcut('K', { metaKey: true })).toBe('open-commands');
  });

  it('resolves undo and redo without hijacking text editing', () => {
    expect(shortcut('z', { ctrlKey: true })).toBe('undo');
    expect(shortcut('z', { metaKey: true, shiftKey: true })).toBe('redo');
    expect(resolveStudioShortcut(
      { key: 'z', ctrlKey: true },
      { ...baseContext, typing: true },
    )).toBeNull();
  });

  it('resolves split only when the selected segment is splittable', () => {
    expect(shortcut('s')).toBe('split');
    expect(resolveStudioShortcut(
      { key: 's' },
      { ...baseContext, canSplit: false },
    )).toBeNull();
  });

  it('limits zoom shortcuts to timeline focus', () => {
    expect(resolveStudioShortcut(
      { key: '+' },
      { ...baseContext, timelineFocused: true },
    )).toBe('zoom-in');
    expect(resolveStudioShortcut(
      { key: '-' },
      { ...baseContext, timelineFocused: true },
    )).toBe('zoom-out');
    expect(shortcut('+')).toBeNull();
  });

  it('resolves playback and seek shortcuts outside text fields', () => {
    expect(shortcut(' ')).toBe('toggle-playback');
    expect(shortcut('ArrowLeft')).toBe('seek-back-small');
    expect(shortcut('ArrowRight')).toBe('seek-forward-small');
    expect(shortcut('ArrowLeft', { shiftKey: true })).toBe('seek-back-large');
    expect(shortcut('ArrowRight', { shiftKey: true })).toBe('seek-forward-large');
  });

  it('resolves Escape while suppressing ordinary editor shortcuts during text input', () => {
    expect(shortcut('Escape')).toBe('escape');
    expect(resolveStudioShortcut(
      { key: 's' },
      { ...baseContext, typing: true },
    )).toBeNull();
    expect(resolveStudioShortcut(
      { key: 'k', ctrlKey: true },
      { ...baseContext, typing: true },
    )).toBeNull();
  });

  it('does not resolve undo or redo when history has no matching entry', () => {
    expect(resolveStudioShortcut(
      { key: 'z', ctrlKey: true },
      { ...baseContext, canUndo: false },
    )).toBeNull();
    expect(resolveStudioShortcut(
      { key: 'z', ctrlKey: true, shiftKey: true },
      { ...baseContext, canRedo: false },
    )).toBeNull();
  });
});
