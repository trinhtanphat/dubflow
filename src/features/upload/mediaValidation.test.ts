import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, validateMediaDuration, validateMediaFile } from './mediaValidation';

describe('media validation', () => {
  it('accepts supported video extensions inside the size limit', () => {
    expect(validateMediaFile({ name: 'episode01.mp4', size: 1024, type: 'video/mp4' } as File)).toBeNull();
    expect(validateMediaFile({ name: 'episode01.mkv', size: 1024, type: 'video/x-matroska' } as File)).toBeNull();
  });

  it('rejects unsupported extensions and videos larger than 5 GB', () => {
    expect(validateMediaFile({ name: 'episode01.avi', size: 1024, type: 'video/avi' } as File)).toMatch(/MP4/);
    expect(validateMediaFile({ name: 'episode01.mp4', size: MAX_MEDIA_BYTES + 1, type: 'video/mp4' } as File)).toMatch(/5 GB/);
  });

  it('rejects duration beyond 3 hours', () => {
    expect(validateMediaDuration(3 * 60 * 60)).toBeNull();
    expect(validateMediaDuration(3 * 60 * 60 + 1)).toMatch(/3 giờ/);
  });
});
