/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import appCss from './app.css?raw';

const reducedMotionBlock = appCss.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

describe('Studio reduced-motion accessibility', () => {
  it('defines one reduced-motion media contract for the interactive Studio surfaces', () => {
    expect(reducedMotionBlock).not.toBe('');
    for (const selector of [
      '.studio-pro-shell',
      '.timeline-panel',
      '.toggle',
      '.ui-tooltip',
      '.command-palette',
      '.reference-fidelity',
    ]) {
      expect(reducedMotionBlock).toContain(selector);
    }
  });

  it('disables non-essential transitions and animations inside the reduced-motion contract', () => {
    expect(reducedMotionBlock).toContain('animation-duration: 0.01ms');
    expect(reducedMotionBlock).toContain('transition-duration: 0.01ms');
  });
});
