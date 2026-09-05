import { describe, expect, it } from 'vitest';
import { isStudioMutationLocked } from './StudioShell';

describe('studio mutation lock', () => {
  it('locks editor mutations for both local saves and active cloud jobs', () => {
    expect(isStudioMutationLocked(false, false)).toBe(false);
    expect(isStudioMutationLocked(true, false)).toBe(true);
    expect(isStudioMutationLocked(false, true)).toBe(true);
    expect(isStudioMutationLocked(true, true)).toBe(true);
  });
});
