import { describe, expect, it } from 'vitest';
import { createMediaSourceToken, verifyMediaSourceToken } from '../src/security/media-source-token';

describe('media source token', () => {
  it('binds the signature to the exact project, key and expiry', async () => {
    const signature = await createMediaSourceToken(
      'secret',
      'project-1',
      'projects/project-1/source/movie.mp4',
      2_000,
    );

    expect(await verifyMediaSourceToken({
      secret: 'secret',
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/movie.mp4',
      expires: 2_000,
      signature,
      nowSeconds: 1_000,
    })).toBe(true);

    expect(await verifyMediaSourceToken({
      secret: 'secret',
      projectId: 'project-1',
      objectKey: 'projects/project-1/source/other.mp4',
      expires: 2_000,
      signature,
      nowSeconds: 1_000,
    })).toBe(false);

    expect(await verifyMediaSourceToken({
      secret: 'secret',
      projectId: 'project-2',
      objectKey: 'projects/project-2/source/movie.mp4',
      expires: 2_000,
      signature,
      nowSeconds: 1_000,
    })).toBe(false);
  });

  it('rejects expired, malformed and outside-project tokens', async () => {
    const signature = await createMediaSourceToken(
      'secret',
      'project-1',
      'projects/project-1/source/movie.mp4',
      2_000,
    );

    expect(await verifyMediaSourceToken({
      secret: 'secret', projectId: 'project-1', objectKey: 'projects/project-1/source/movie.mp4',
      expires: 2_000, signature, nowSeconds: 2_000,
    })).toBe(false);
    expect(await verifyMediaSourceToken({
      secret: 'secret', projectId: 'project-1', objectKey: 'projects/project-1/source/movie.mp4',
      expires: 2_000, signature: 'not-hex', nowSeconds: 1_000,
    })).toBe(false);
    await expect(createMediaSourceToken('secret', 'project-1', 'projects/project-2/source/movie.mp4', 2_000))
      .rejects.toThrow(/outside the project/i);
  });
});
