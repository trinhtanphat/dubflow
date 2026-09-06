import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor } from '../src/services/media/container';

describe('ContainerMediaProcessor audio extraction', () => {
  it('requests bounded 300-second windows with the canonical 15-second overlap', async () => {
    let requestBody: unknown;
    const media = new ContainerMediaProcessor({
      getByName(name: string) {
        expect(name).toBe('p1');
        return {
          async fetch(request: Request) {
            requestBody = await request.clone().json();
            return Response.json({
              chunks: [{
                objectKey: 'projects/p1/audio/00000.wav',
                offsetMs: 0,
                durationMs: 300_000,
              }],
            });
          },
        };
      },
    });

    const chunks = await media.extractAudioChunks('p1', 'projects/p1/source/original.mp4');

    expect(requestBody).toEqual({
      projectId: 'p1',
      objectKey: 'projects/p1/source/original.mp4',
      chunkSeconds: 300,
      overlapSeconds: 15,
    });
    expect(chunks).toEqual([{
      objectKey: 'projects/p1/audio/00000.wav',
      offsetMs: 0,
      durationMs: 300_000,
    }]);
  });
});
