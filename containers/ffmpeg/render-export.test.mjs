import { describe, expect, it } from 'vitest';
import { buildRenderExportArgs, validateRenderExportInput } from './render-export.mjs';

describe('FFmpeg final dubbing export', () => {
  const input = {
    projectId: 'project-1',
    objectKey: 'projects/project-1/source/source.mp4',
    clips: [
      { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/dubbed/s1.mp3' },
      { segmentId: 's2', startMs: 3000, endMs: 5000, objectKey: 'projects/project-1/dubbed/s2.mp3' },
    ],
  };

  it('accepts a bounded project-scoped render manifest and rejects cross-project clips', () => {
    expect(validateRenderExportInput(input)).toEqual(input);
    expect(() => validateRenderExportInput({
      ...input,
      clips: [{ ...input.clips[0], objectKey: 'projects/other/dubbed/s1.mp3' }],
    })).toThrow(/project/i);
  });

  it('builds deterministic MP4 render args with a silent base and delayed dubbed clips', () => {
    const args = buildRenderExportArgs({
      sourcePath: '/tmp/source',
      outputPath: '/tmp/dubbed.mp4',
      durationMs: 6000,
      clips: input.clips,
      clipPaths: ['/tmp/s1.mp3', '/tmp/s2.mp3'],
    });

    expect(args).toContain('-filter_complex');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('adelay=1000|1000');
    expect(graph).toContain('adelay=3000|3000');
    expect(graph).toContain('amix=inputs=3');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args.at(-1)).toBe('/tmp/dubbed.mp4');
  });
});
