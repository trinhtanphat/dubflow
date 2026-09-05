import { describe, expect, it, vi } from 'vitest';
import { buildStudioCommands, runStudioCommand } from './studioCommands';

describe('Studio command registry', () => {
  it('exposes the V2 editor commands and preserves disabled state', () => {
    const calls: string[] = [];
    const commands = buildStudioCommands({
      canSplit: true,
      canUndo: false,
      canRedo: true,
      split: () => calls.push('split'),
      undo: () => calls.push('undo'),
      redo: () => calls.push('redo'),
      zoomIn: () => calls.push('zoom-in'),
      zoomOut: () => calls.push('zoom-out'),
      openSources: () => calls.push('sources'),
      openInspector: () => calls.push('inspector'),
    });

    expect(commands.map((command) => command.id)).toEqual([
      'split-segment',
      'undo',
      'redo',
      'zoom-in',
      'zoom-out',
      'open-sources',
      'open-inspector',
    ]);
    expect(commands.find((command) => command.id === 'undo')?.disabled).toBe(true);
    expect(commands.find((command) => command.id === 'split-segment')?.shortcut).toBe('S');
  });

  it('does not execute a disabled command', () => {
    const run = vi.fn();
    runStudioCommand({ id: 'undo', label: 'Hoàn tác', disabled: true, run });
    expect(run).not.toHaveBeenCalled();
  });

  it('executes an enabled command exactly once', () => {
    const run = vi.fn();
    runStudioCommand({ id: 'redo', label: 'Làm lại', run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
