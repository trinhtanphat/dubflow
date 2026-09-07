import { describe, expect, it } from 'vitest';
import { checkRemuxRuntimeReady } from '../src/services/media/remux-readiness';

describe('R2 MP4 remux runtime readiness', () => {
  it('qualifies the bundled AAC encoder path without Stream or Containers', async () => {
    await expect(checkRemuxRuntimeReady()).resolves.toBe(true);
  });
});
