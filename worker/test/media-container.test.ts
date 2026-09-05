import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor } from '../src/services/media/container';

describe('ContainerMediaProcessor', () => {
  it('requests bounded five-minute audio chunks from a project-named container', async () => {
    const requests: Request[] = [];
    const namespace = {
      getByName(name: string) {
        expect(name).toBe('project-1');
        return {
          async fetch(request: Request) {
            requests.push(request);
            return Response.json({
              chunks: [
                { objectKey: 'projects/project-1/audio/000.wav', offsetMs: 0, durationMs: 300000 },
              ],
            });
          },
        };
      },
    };

    const processor = new ContainerMediaProcessor(namespace);
    const chunks = await processor.extractAudioChunks('project-1', 'projects/project-1/source/source.mp4');

    expect(chunks).toEqual([
      { objectKey: 'projects/project-1/audio/000.wav', offsetMs: 0, durationMs: 300000 },
    ]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/extract-audio-chunks');
    expect(await requests[0].json()).toEqual({
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/source.mp4',
      chunkSeconds: 300,
    });
  });

  it('rejects malformed or cross-project chunk manifests', async () => {
    const namespace = {
      getByName() {
        return {
          async fetch() {
            return Response.json({
              chunks: [
                { objectKey: 'projects/other/audio/000.wav', offsetMs: 0, durationMs: 300000 },
              ],
            });
          },
        };
      },
    };

    const processor = new ContainerMediaProcessor(namespace);
    await expect(
      processor.extractAudioChunks('project-1', 'projects/project-1/source/source.mp4'),
    ).rejects.toMatchObject({ code: 'MEDIA_PROCESSOR_RESPONSE_INVALID' });
  });
});
