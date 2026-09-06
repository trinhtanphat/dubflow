import { describe, expect, it, vi } from 'vitest';
import { ContainerMediaProcessor, MediaProcessorError } from './container';

describe('ContainerMediaProcessor', () => {
  it('fails with a typed capability error when FFMPEG_CONTAINER is unavailable', async () => {
    const processor = new ContainerMediaProcessor(undefined);

    await expect(processor.probe('projects/project-1/source/input.mp4')).rejects.toMatchObject({
      name: 'MediaProcessorError',
      code: 'MEDIA_PROCESSOR_UNAVAILABLE',
    } satisfies Partial<MediaProcessorError>);
  });

  it('rejects cross-project source objects before stem separation', async () => {
    const fetch = vi.fn();
    const processor = new ContainerMediaProcessor({ getByName: () => ({ fetch }) });
    await expect(processor.separateStems('p1', 'projects/p2/source/a.mp4', 'r1'))
      .rejects.toMatchObject({ code: 'MEDIA_OBJECT_KEY_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid source revisions before stem separation', async () => {
    const fetch = vi.fn();
    const processor = new ContainerMediaProcessor({ getByName: () => ({ fetch }) });
    await expect(processor.separateStems('p1', 'projects/p1/source/a.mp4', '../bad'))
      .rejects.toMatchObject({ code: 'MEDIA_STEM_REVISION_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts only exact canonical stem response keys', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      dialogueObjectKey: 'projects/p1/stems/r1/dialogue.wav',
      backgroundObjectKey: 'projects/p1/stems/r1/background.wav',
    }));
    const processor = new ContainerMediaProcessor({ getByName: () => ({ fetch }) });

    await expect(processor.separateStems('p1', 'projects/p1/source/a.mp4', 'r1')).resolves.toEqual({
      dialogueObjectKey: 'projects/p1/stems/r1/dialogue.wav',
      backgroundObjectKey: 'projects/p1/stems/r1/background.wav',
    });
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe('/separate-stems');
  });
});
