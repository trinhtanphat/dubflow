/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import appCss from './app.css?inline';

const mediaDeclaration = '@media (prefers-reduced-motion: reduce)';
const reducedMotionStart = appCss.indexOf(mediaDeclaration);
const reducedMotionBlock = reducedMotionStart >= 0 ? appCss.slice(reducedMotionStart) : '';

describe('Studio reduced-motion accessibility', () => {
  it('defines one reduced-motion media contract for the interactive Studio surfaces', () => {
    expect(reducedMotionBlock).toContain(mediaDeclaration);
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
