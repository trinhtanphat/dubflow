import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor } from '../src/services/media/container';

describe('Phase 4C language-scoped container rendering', () => {
  it('sends target/export identity and accepts only the exact immutable output key', async () => {
    const requests: Request[] = [];
    const processor = new ContainerMediaProcessor({
      getByName(name: string) {
        expect(name).toBe('project-1');
        return {
          async fetch(request: Request) {
            requests.push(request);
            return Response.json({ exportObjectKey: 'projects/project-1/exports/ja/export-ja-1.mp4' });
          },
        };
      },
    });
    const clips = [{
      segmentId: 's1', startMs: 0, endMs: 1500,
      objectKey: 'projects/project-1/voices/ja/s1/3.mp3',
    }];

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
      { targetLanguage: 'ja', exportId: 'export-ja-1' },
    )).resolves.toEqual({ exportObjectKey: 'projects/project-1/exports/ja/export-ja-1.mp4' });

    expect(await requests[0].json()).toEqual({
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/source.mp4',
      clips,
      targetLanguage: 'ja',
      exportId: 'export-ja-1',
    });
  });

  it('rejects a legacy language-less output returned for a modern render request', async () => {
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch() { return Response.json({ exportObjectKey: 'projects/project-1/export/dubbed.mp4' }); } };
      },
    });
    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      [{ segmentId: 's1', startMs: 0, endMs: 1000, objectKey: 'projects/project-1/voices/ja/s1/3.mp3' }],
      { targetLanguage: 'ja', exportId: 'export-ja-1' },
    )).rejects.toMatchObject({ code: 'MEDIA_PROCESSOR_RESPONSE_INVALID' });
  });
});
