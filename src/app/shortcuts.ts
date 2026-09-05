export type StudioShortcutAction =
  | 'open-commands'
  | 'undo'
  | 'redo'
  | 'split'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-playback'
  | 'seek-back-small'
  | 'seek-forward-small'
  | 'seek-back-large'
  | 'seek-forward-large'
  | 'escape';

export type StudioShortcutInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

export type StudioShortcutContext = {
  typing: boolean;
  timelineFocused: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSplit: boolean;
};

export function resolveStudioShortcut(
  input: StudioShortcutInput,
  context: StudioShortcutContext,
): StudioShortcutAction | null {
  const key = input.key;
  const lowerKey = key.toLowerCase();
  const primaryModifier = Boolean(input.ctrlKey || input.metaKey);

  if (key === 'Escape') return 'escape';
  if (context.typing || input.altKey) return null;

  if (primaryModifier && lowerKey === 'k') return 'open-commands';
  if (primaryModifier && lowerKey === 'z') {
    if (input.shiftKey) return context.canRedo ? 'redo' : null;
    return context.canUndo ? 'undo' : null;
  }

  if (primaryModifier) return null;
  if (lowerKey === 's') return context.canSplit ? 'split' : null;
  if (key === ' ' || key === 'Spacebar') return 'toggle-playback';
  if (key === 'ArrowLeft') return input.shiftKey ? 'seek-back-large' : 'seek-back-small';
  if (key === 'ArrowRight') return input.shiftKey ? 'seek-forward-large' : 'seek-forward-small';
  if (context.timelineFocused && (key === '+' || key === '=')) return 'zoom-in';
  if (context.timelineFocused && key === '-') return 'zoom-out';

  return null;
}
