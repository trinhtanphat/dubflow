import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, validateMediaDuration, validateMediaFile, validateMediaSelection } from './mediaValidation';

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

  it('checks duration before accepting a selected media file', async () => {
    const file = { name: 'episode01.mp4', size: 1024, type: 'video/mp4' } as File;
    await expect(validateMediaSelection(file, async () => 3 * 60 * 60 + 1)).resolves.toMatch(/3 giờ/);
    await expect(validateMediaSelection(file, async () => 45 * 60 + 23)).resolves.toBeNull();
  });

  it('does not probe duration when basic file validation already fails', async () => {
    const file = { name: 'episode01.avi', size: 1024, type: 'video/avi' } as File;
    let probed = false;
    const result = await validateMediaSelection(file, async () => { probed = true; return 1; });
    expect(result).toMatch(/MP4/);
    expect(probed).toBe(false);
  });
});
