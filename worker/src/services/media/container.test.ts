import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor, MediaProcessorError } from './container';

describe('ContainerMediaProcessor', () => {
  it('fails with a typed capability error when FFMPEG_CONTAINER is unavailable', async () => {
    const processor = new ContainerMediaProcessor(undefined);

    await expect(processor.probe('projects/project-1/source/input.mp4')).rejects.toMatchObject({
      name: 'MediaProcessorError',
      code: 'MEDIA_PROCESSOR_UNAVAILABLE',
    } satisfies Partial<MediaProcessorError>);
  });
});
