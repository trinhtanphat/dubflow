import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appCss = readFileSync('src/app/app.css', 'utf8');
const mediaDeclaration = '@media (prefers-reduced-motion: reduce)';
const reducedMotionStart = appCss.indexOf(mediaDeclaration);
const reducedMotionBlock = reducedMotionStart >= 0 ? appCss.slice(reducedMotionStart) : '';

test('defines one reduced-motion media contract for the interactive Studio surfaces', () => {
  assert.ok(reducedMotionBlock.includes(mediaDeclaration));
  for (const selector of [
    '.studio-pro-shell',
    '.timeline-panel',
    '.toggle',
    '.ui-tooltip',
    '.command-palette',
    '.reference-fidelity',
  ]) {
    assert.ok(reducedMotionBlock.includes(selector), `reduced-motion contract must include ${selector}`);
  }
});

test('disables non-essential transitions and animations inside the reduced-motion contract', () => {
  assert.ok(reducedMotionBlock.includes('animation-duration: 0.01ms'));
  assert.ok(reducedMotionBlock.includes('transition-duration: 0.01ms'));
});
