/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import wrapperSource from './StudioShell.tsx?raw';
import baseSource from './StudioShellBase.tsx?raw';

const source = `${wrapperSource}\n${baseSource}`;

describe('StudioShell command surface wiring', () => {
  it('does not leave the command palette trigger as a no-op', () => {
    expect(source).not.toContain('onOpenCommands={() => {}}');
    expect(source).toContain('CommandPalette');
    expect(source).toContain('commandPaletteOpen');
  });

  it('routes the complete shortcut resolver through the shell', () => {
    expect(source).toContain('resolveStudioShortcut');
    expect(source).toContain("case 'toggle-playback'");
    expect(source).toContain("case 'seek-back-small'");
    expect(source).toContain("case 'seek-forward-large'");
  });

  it('keeps command palette lifecycle callbacks stable across playhead rerenders', () => {
    expect(source).toContain('const openCommandPalette = useCallback');
    expect(source).toContain('const closeCommandPalette = useCallback');
    expect(source).toContain('onOpenCommands={openCommandPalette}');
    expect(source).toContain('onClose={closeCommandPalette}');
  });
});
