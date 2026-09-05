import { describe, expect, it } from 'vitest';
import { buildAtempoChain, buildRenderExportArgs, validateRenderExportInput } from './render-export.mjs';

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

  it('builds deterministic atempo chains beyond the native 0.5x..2x range', () => {
    expect(buildAtempoChain(3000, 1500)).toBe('atempo=2');
    expect(buildAtempoChain(1000, 2000)).toBe('atempo=0.5');
    expect(buildAtempoChain(4000, 1000)).toBe('atempo=2,atempo=2');
    expect(buildAtempoChain(1000, 4000)).toBe('atempo=0.5,atempo=0.5');
    expect(buildAtempoChain(1500, 1500)).toBe('');
  });

  it('fits each dubbed clip to its segment window before delay and final mix', () => {
    const args = buildRenderExportArgs({
      sourcePath: '/tmp/source',
      outputPath: '/tmp/dubbed.mp4',
      durationMs: 6000,
      clips: input.clips,
      clipPaths: ['/tmp/s1.mp3', '/tmp/s2.mp3'],
      clipDurationsMs: [3000, 1000],
    });

    expect(args).toContain('-filter_complex');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('atempo=2,atrim=duration=1.5');
    expect(graph).toContain('atempo=0.5,atrim=duration=2');
    expect(graph).toContain('adelay=1000|1000');
    expect(graph).toContain('adelay=3000|3000');
    expect(graph).toContain('amix=inputs=3');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args.at(-1)).toBe('/tmp/dubbed.mp4');
  });
});
