import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor } from '../src/services/media/container';
import type { RenderExportOptions } from '../src/services/media/types';

describe('Phase 4D media render contract', () => {
  const clips = [{
    segmentId: 's1', startMs: 0, endMs: 1500,
    objectKey: 'projects/project-1/voices/ja/s1/3.mp3',
  }];

  it('forwards a validated separated-background request exactly to the project container', async () => {
    const requests: Request[] = [];
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch(request: Request) {
          requests.push(request);
          return Response.json({ exportObjectKey: 'projects/project-1/exports/ja/export-ja-1.mp4' });
        } };
      },
    });

    await processor.renderExport(
      'project-1', 'projects/project-1/source/source.mp4', clips,
      {
        targetLanguage: 'ja', exportId: 'export-ja-1', audioMode: 'separated_background',
        backgroundObjectKey: 'projects/project-1/stems/3/qualified-provider/background.wav',
      },
    );

    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({
      audioMode: 'separated_background',
      backgroundObjectKey: 'projects/project-1/stems/3/qualified-provider/background.wav',
    });
  });

  it('rejects invalid audio/stem combinations before any container call', async () => {
    let calls = 0;
    const processor = new ContainerMediaProcessor({
      getByName() { return { async fetch() { calls += 1; return Response.json({}); } }; },
    });

    const invalid: RenderExportOptions[] = [
      { targetLanguage: 'ja', exportId: 'e1', audioMode: 'bad' as never },
      { targetLanguage: 'ja', exportId: 'e2', audioMode: 'separated_background' },
      {
        targetLanguage: 'ja', exportId: 'e3', audioMode: 'duck_original',
        backgroundObjectKey: 'projects/project-1/stems/3/p/background.wav',
      },
      {
        targetLanguage: 'ja', exportId: 'e4', audioMode: 'separated_background',
        backgroundObjectKey: 'projects/other/stems/3/p/background.wav',
      },
    ];

    for (const options of invalid) {
      await expect(processor.renderExport(
        'project-1', 'projects/project-1/source/source.mp4', clips, options,
      )).rejects.toMatchObject({ code: 'MEDIA_EXPORT_OPTIONS_INVALID' });
    }
    expect(calls).toBe(0);
  });
});
