import { describe, expect, it } from 'vitest';
import { validateRenderExportInput } from './render-export.mjs';

describe('Phase 4D FFmpeg render request validation', () => {
  const modern = {
    projectId: 'project-1',
    objectKey: 'projects/project-1/source/source.mp4',
    targetLanguage: 'ja',
    exportId: 'export-ja-1',
    clips: [{
      segmentId: 's1', startMs: 0, endMs: 1500,
      objectKey: 'projects/project-1/voices/ja/s1/3.mp3',
    }],
  };

  it('normalizes omitted audio mode to dubbed_only', () => {
    expect(validateRenderExportInput(modern)).toMatchObject({ audioMode: 'dubbed_only' });
  });

  it('accepts only a project-scoped stem for separated_background', () => {
    expect(validateRenderExportInput({
      ...modern,
      audioMode: 'separated_background',
      backgroundObjectKey: 'projects/project-1/stems/3/qualified-provider/background.wav',
    })).toMatchObject({
      audioMode: 'separated_background',
      backgroundObjectKey: 'projects/project-1/stems/3/qualified-provider/background.wav',
    });
  });

  it('rejects invalid mode, missing separated stem, non-separated stem, and cross-project stem', () => {
    expect(() => validateRenderExportInput({ ...modern, audioMode: 'bad' })).toThrow(/audio mode/i);
    expect(() => validateRenderExportInput({ ...modern, audioMode: 'separated_background' })).toThrow(/background/i);
    expect(() => validateRenderExportInput({
      ...modern, audioMode: 'duck_original',
      backgroundObjectKey: 'projects/project-1/stems/3/p/background.wav',
    })).toThrow(/background/i);
    expect(() => validateRenderExportInput({
      ...modern, audioMode: 'separated_background',
      backgroundObjectKey: 'projects/other/stems/3/p/background.wav',
    })).toThrow(/project/i);
  });
});
