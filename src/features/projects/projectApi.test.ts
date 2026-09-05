import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProject } from './projectApi';

afterEach(() => vi.unstubAllGlobals());

describe('project API', () => {
  it('reads one project through an encoded URL', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ id: 'p / 1', userId: 'u', title: 'Cloud', sourceLanguage: 'zh', targetLanguage: 'vi', status: 'needs_review', durationMs: 1000 });
    });
    await expect(getProject('p / 1')).resolves.toMatchObject({ title: 'Cloud', durationMs: 1000 });
    expect(calls).toEqual(['/api/projects/p%20%2F%201']);
  });
});
