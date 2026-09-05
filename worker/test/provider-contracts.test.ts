import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { R2MediaBucketLike } from '../src/cloudflare/r2';
import type { Env } from '../src/env';

const ai = {
  async run(_model: string, _input: unknown) {
    return { ok: true };
  },
} satisfies AiBinding;

const bucket = {
  async createMultipartUpload(key: string) {
    return {
      key,
      uploadId: 'upload-1',
      async uploadPart(partNumber: number, _value: ReadableStream | ArrayBuffer | string | Blob) {
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        return { key, size: parts.length };
      },
      async abort() {},
    };
  },
  resumeMultipartUpload(key: string, uploadId: string) {
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, _value: ReadableStream | ArrayBuffer | string | Blob) {
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        return { key, size: parts.length };
      },
      async abort() {},
    };
  },
  async get() {
    return null;
  },
} satisfies R2MediaBucketLike;

describe('Cloudflare provider contracts', () => {
  it('accepts portable AI and R2 bindings plus the Google secret', () => {
    const env = {
      DB: {} as Env['DB'],
      MEDIA: bucket,
      AI: ai,
      ASSETS: { fetch: async () => new Response('asset') },
      GOOGLE_CLOUD_TRANSLATE_API_KEY: 'secret',
    } satisfies Env;

    expect(env.MEDIA).toBe(bucket);
    expect(env.AI).toBe(ai);
    expect(env.GOOGLE_CLOUD_TRANSLATE_API_KEY).toBe('secret');
  });
});
