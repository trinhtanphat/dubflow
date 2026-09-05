/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import source from './StudioShell.tsx?raw';

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
});
