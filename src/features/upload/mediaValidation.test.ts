import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, MAX_MEDIA_DURATION_SECONDS, validateMediaDuration, validateMediaFile } from './mediaValidation';

describe('media validation', () => {
  it('accepts supported formats at the size boundary', () => {
    for (const name of ['episode.mp4', 'episode.webm', 'episode.mkv', 'episode.mov']) {
      expect(validateMediaFile({ name, size: MAX_MEDIA_BYTES })).toEqual({ valid: true });
    }
  });

  it('rejects unsupported formats and files larger than 5 GB', () => {
    expect(validateMediaFile({ name: 'episode.avi', size: 1024 }).valid).toBe(false);
    expect(validateMediaFile({ name: 'episode.mp4', size: MAX_MEDIA_BYTES + 1 }).valid).toBe(false);
  });

  it('enforces the three-hour duration boundary', () => {
    expect(validateMediaDuration(MAX_MEDIA_DURATION_SECONDS)).toEqual({ valid: true });
    expect(validateMediaDuration(MAX_MEDIA_DURATION_SECONDS + 0.001).valid).toBe(false);
  });
});
