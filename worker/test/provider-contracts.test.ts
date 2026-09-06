import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { R2BucketLike } from '../src/cloudflare/r2';
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
} satisfies R2BucketLike;

const analytics = {
  writeDataPoint(_point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) {},
} satisfies Env['ANALYTICS'];

const rateLimit = {
  async limit(_input: { key: string }) {
    return { success: true };
  },
} satisfies Env['RATE_LIMIT_PROCESS'];

const ffmpegContainer = {
  getByName(_name: string) {
    return {
      async fetch(_request: Request) {
        return Response.json({ ok: true });
      },
    };
  },
} satisfies Env['FFMPEG_CONTAINER'];

const dubbingWorkflow = {
  async create(_input: { id?: string; params?: unknown }) {
    return { id: 'workflow-1' };
  },
} satisfies Env['DUBBING_WORKFLOW'];

const exportWorkflow = {
  async create(_input: { id?: string; params?: unknown }) {
    return { id: 'export-workflow-1' };
  },
} satisfies Env['EXPORT_WORKFLOW'];

const languageTranslationWorkflow = {
  async create(_input: { id?: string; params?: unknown }) {
    return { id: 'language-translation-workflow-1' };
  },
} satisfies Env['LANGUAGE_TRANSLATION_WORKFLOW'];

describe('Cloudflare provider contracts', () => {
  it('accepts portable AI, R2, Analytics Engine, rate limits, Container and Workflow bindings plus provider secrets', () => {
    const env = {
      DB: {} as Env['DB'],
      MEDIA: bucket,
      AI: ai,
      ASSETS: { fetch: async () => new Response('asset') },
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: rateLimit,
      RATE_LIMIT_EXPORT: rateLimit,
      RATE_LIMIT_TRANSLATE: rateLimit,
      RATE_LIMIT_VOICE: rateLimit,
      RATE_LIMIT_UPLOAD: rateLimit,
      RATE_LIMIT_VOICE_CLONE: rateLimit,
      FFMPEG_CONTAINER: ffmpegContainer,
      DUBBING_WORKFLOW: dubbingWorkflow,
      EXPORT_WORKFLOW: exportWorkflow,
      LANGUAGE_TRANSLATION_WORKFLOW: languageTranslationWorkflow,
      GOOGLE_CLOUD_TRANSLATE_API_KEY: 'secret',
      ELEVENLABS_API_KEY: 'voice-secret',
      ELEVENLABS_DEFAULT_VOICE_ID: 'voice-id',
    } satisfies Env;

    expect(env.MEDIA).toBe(bucket);
    expect(env.AI).toBe(ai);
    expect(env.ANALYTICS).toBe(analytics);
    expect(env.RATE_LIMIT_PROCESS).toBe(rateLimit);
    expect(env.RATE_LIMIT_EXPORT).toBe(rateLimit);
    expect(env.RATE_LIMIT_TRANSLATE).toBe(rateLimit);
    expect(env.RATE_LIMIT_VOICE).toBe(rateLimit);
    expect(env.RATE_LIMIT_UPLOAD).toBe(rateLimit);
    expect(env.RATE_LIMIT_VOICE_CLONE).toBe(rateLimit);
    expect(env.FFMPEG_CONTAINER).toBe(ffmpegContainer);
    expect(env.DUBBING_WORKFLOW).toBe(dubbingWorkflow);
    expect(env.EXPORT_WORKFLOW).toBe(exportWorkflow);
    expect(env.LANGUAGE_TRANSLATION_WORKFLOW).toBe(languageTranslationWorkflow);
    expect(env.GOOGLE_CLOUD_TRANSLATE_API_KEY).toBe('secret');
  });
});