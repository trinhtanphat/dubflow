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

  it('renders a project-scoped final export from timed dubbed clips', async () => {
    const requests: Request[] = [];
    const namespace = {
      getByName(name: string) {
        expect(name).toBe('project-1');
        return {
          async fetch(request: Request) {
            requests.push(request);
            return Response.json({ exportObjectKey: 'projects/project-1/export/dubbed.mp4' });
          },
        };
      },
    };
    const processor = new ContainerMediaProcessor(namespace);
    const clips = [
      { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/dubbed/s1.mp3' },
      { segmentId: 's2', startMs: 3000, endMs: 5000, objectKey: 'projects/project-1/dubbed/s2.mp3' },
    ];

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
    )).resolves.toEqual({ exportObjectKey: 'projects/project-1/export/dubbed.mp4' });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/render-export');
    expect(await requests[0].json()).toEqual({
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/source.mp4',
      clips,
    });
  });

  it('rejects a cross-project clip before calling the container', async () => {
    let calls = 0;
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch() { calls += 1; return Response.json({}); } };
      },
    });
    await expect(processor.renderExport('project-1', 'projects/project-1/source/source.mp4', [
      { segmentId: 's1', startMs: 0, endMs: 1000, objectKey: 'projects/other/dubbed/s1.mp3' },
    ])).rejects.toMatchObject({ code: 'MEDIA_OBJECT_KEY_INVALID' });
    expect(calls).toBe(0);
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
