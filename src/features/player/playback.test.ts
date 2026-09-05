import { describe, expect, it } from 'vitest';
import { frameStepMs, mediaUrlForProject } from './playback';

describe('player playback helpers', () => {
  it('only exposes a same-origin media URL for projects with source media', () => {
    expect(mediaUrlForProject({ id: 'p1', sourceObjectKey: 'projects/p1/source/a.mp4' })).toBe('/api/projects/p1/media');
    expect(mediaUrlForProject({ id: 'p1', sourceObjectKey: null })).toBeNull();
  });

  it('uses project frame rate when available and 30fps otherwise', () => {
    expect(frameStepMs(25)).toBe(40);
    expect(frameStepMs(null)).toBeCloseTo(1000 / 30);
  });
});
