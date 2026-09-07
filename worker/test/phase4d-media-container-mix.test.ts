import { describe, expect, it } from 'vitest';
import { ContainerMediaProcessor } from '../src/services/media/container';

const clips = [
  {
    segmentId: 's1',
    startMs: 1000,
    endMs: 2500,
    objectKey: 'projects/project-1/voices/ja/s1/1.mp3',
  },
];

const preserve = {
  targetLanguage: 'ja' as const,
  exportId: 'exp-1',
  mixMode: 'preserve_background' as const,
  backgroundObjectKey: 'projects/project-1/separation/2/demucs-container/sha256-8726e21a/background.wav',
};

describe('Phase 4D media container preserve-background contract', () => {
  it('forwards one canonical project-scoped background stem to the render container', async () => {
    const requests: Request[] = [];
    const processor = new ContainerMediaProcessor({
      getByName(name: string) {
        expect(name).toBe('project-1');
        return {
          async fetch(request: Request) {
            requests.push(request);
            return Response.json({ exportObjectKey: 'projects/project-1/exports/ja/exp-1.mp4' });
          },
        };
      },
    });

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
      preserve,
    )).resolves.toEqual({ exportObjectKey: 'projects/project-1/exports/ja/exp-1.mp4' });

    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/source.mp4',
      clips,
      ...preserve,
    });
  });

  it('fails before the container when preserve_background has no durable background stem', async () => {
    let calls = 0;
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch() { calls += 1; return Response.json({}); } };
      },
    });

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
      { targetLanguage: 'ja', exportId: 'exp-1', mixMode: 'preserve_background' },
    )).rejects.toMatchObject({ code: 'MEDIA_EXPORT_OPTIONS_INVALID' });
    expect(calls).toBe(0);
  });

  it('rejects a cross-project background stem before the container', async () => {
    let calls = 0;
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch() { calls += 1; return Response.json({}); } };
      },
    });

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
      {
        ...preserve,
        backgroundObjectKey: 'projects/other/separation/2/demucs-container/sha256-8726e21a/background.wav',
      },
    )).rejects.toMatchObject({ code: 'MEDIA_OBJECT_KEY_INVALID' });
    expect(calls).toBe(0);
  });

  it('rejects an accidental background stem on dubbed_only instead of silently changing the mix', async () => {
    let calls = 0;
    const processor = new ContainerMediaProcessor({
      getByName() {
        return { async fetch() { calls += 1; return Response.json({}); } };
      },
    });

    await expect(processor.renderExport(
      'project-1',
      'projects/project-1/source/source.mp4',
      clips,
      {
        targetLanguage: 'ja',
        exportId: 'exp-1',
        mixMode: 'dubbed_only',
        backgroundObjectKey: preserve.backgroundObjectKey,
      },
    )).rejects.toMatchObject({ code: 'MEDIA_EXPORT_OPTIONS_INVALID' });
    expect(calls).toBe(0);
  });
});
