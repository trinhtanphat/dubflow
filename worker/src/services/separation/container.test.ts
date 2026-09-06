import { describe, expect, it, vi } from 'vitest';
import { ContainerStemSeparationProvider } from './container';

describe('ContainerStemSeparationProvider', () => {
  it('reports unavailable without a media processor or provider capability', () => {
    expect(new ContainerStemSeparationProvider(undefined, false).available).toBe(false);
    expect(new ContainerStemSeparationProvider(undefined, true).available).toBe(false);
  });

  it('delegates the exact project, source object, and source revision to media separation', async () => {
    const separateStems = vi.fn().mockResolvedValue({
      dialogueObjectKey: 'projects/p1/stems/r1/dialogue.wav',
      backgroundObjectKey: 'projects/p1/stems/r1/background.wav',
    });
    const provider = new ContainerStemSeparationProvider({ separateStems }, true);

    await expect(provider.separate({
      projectId: 'p1',
      sourceObjectKey: 'projects/p1/source/a.mp4',
      sourceRevision: 'r1',
    })).resolves.toEqual({
      dialogueObjectKey: 'projects/p1/stems/r1/dialogue.wav',
      backgroundObjectKey: 'projects/p1/stems/r1/background.wav',
    });
    expect(separateStems).toHaveBeenCalledWith('p1', 'projects/p1/source/a.mp4', 'r1');
  });

  it('fails closed when separation is unavailable', async () => {
    const provider = new ContainerStemSeparationProvider(undefined, false);
    await expect(provider.separate({
      projectId: 'p1',
      sourceObjectKey: 'projects/p1/source/a.mp4',
      sourceRevision: 'r1',
    })).rejects.toMatchObject({ code: 'STEM_SEPARATION_UNAVAILABLE' });
  });
});
