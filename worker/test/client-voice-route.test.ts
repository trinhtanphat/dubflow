import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createClientVoiceRoutes } from '../src/routes/client-voice';
import type { SegmentTranslation } from '../src/db/segment-translations';

const validHeaders = {
  'content-type': 'application/octet-stream',
  'X-DubFlow-PCM-Format': 's16le',
  'X-DubFlow-PCM-Sample-Rate': '24000',
  'X-DubFlow-PCM-Channels': '1',
  'X-DubFlow-Translation-Version': '3',
};

function translation(overrides: Partial<SegmentTranslation> = {}): SegmentTranslation {
  return {
    segmentId: 's1',
    projectId: 'p1',
    targetLanguage: 'vi',
    translatedText: 'Xin chào',
    translationEngine: 'workers-ai',
    translationStatus: 'completed',
    translationContextRevision: null,
    voiceStatus: 'pending',
    dubbedObjectKey: null,
    version: 3,
    ...overrides,
  };
}

function testApp(options: {
  current?: SegmentTranslation | null;
  limiterSuccess?: boolean;
  calls?: string[];
} = {}) {
  const calls = options.calls ?? [];
  const current = options.current === undefined ? translation() : options.current;
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createClientVoiceRoutes({
    makeRepositories: () => ({
      projects: {
        async getByIdForUser(projectId: string, userId: string) {
          calls.push(`project:${projectId}:${userId}`);
          return projectId === 'p1' && userId === 'dev-user' ? { id: 'p1' } as never : null;
        },
      },
      segments: {
        async get(projectId: string, segmentId: string, userId: string) {
          calls.push(`segment:${projectId}:${segmentId}:${userId}`);
          return projectId === 'p1' && segmentId === 's1' && userId === 'dev-user' ? { id: 's1' } as never : null;
        },
      },
      translations: {
        async get() {
          calls.push('translation:get');
          return current;
        },
        async setVoiceResultForVersion(
          _projectId: string,
          _segmentId: string,
          _userId: string,
          _targetLanguage: 'vi',
          expectedVersion: number,
          objectKey: string,
        ) {
          calls.push(`translation:set:${expectedVersion}:${objectKey}`);
          return translation({
            version: expectedVersion,
            voiceStatus: 'completed',
            dubbedObjectKey: objectKey,
          });
        },
      },
    }) as never,
  }));

  let stored: { key: string; bytes: Uint8Array } | null = null;
  const env = {
    ANALYTICS: { writeDataPoint() {} },
    RATE_LIMIT_VOICE: {
      async limit({ key }: { key: string }) {
        calls.push(`limit:${key}`);
        return { success: options.limiterSuccess ?? true };
      },
    },
    MEDIA: {
      async put(key: string, value: ArrayBuffer) {
        stored = { key, bytes: new Uint8Array(value) };
        calls.push(`r2:${key}`);
        return {};
      },
    },
  } as unknown as Env;

  return { app, env, calls, stored: () => stored };
}

async function put(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = validHeaders,
) {
  const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return app.request(path, { method: 'PUT', headers, body: bodyBuffer }, env);
}

describe('client-generated PCM voice route', () => {
  it('stores exact s16le bytes at the canonical exact-version R2 key and persists voice completion', async () => {
    const harness = testApp();
    const pcm = new Uint8Array([0, 0, 1, 0, 255, 255, 2, 0]);
    const response = await put(harness.app, harness.env, '/api/projects/p1/translations/vi/s1/voice-pcm', pcm);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      targetLanguage: 'vi',
      segmentId: 's1',
      version: 3,
      voiceStatus: 'completed',
      objectKey: 'projects/p1/voices/vi/s1/3.pcm',
    });
    expect(harness.stored()).toEqual({
      key: 'projects/p1/voices/vi/s1/3.pcm',
      bytes: pcm,
    });
    expect(harness.calls).toEqual([
      'project:p1:dev-user',
      'segment:p1:s1:dev-user',
      'translation:get',
      'limit:dev-user:voice',
      'r2:projects/p1/voices/vi/s1/3.pcm',
      'translation:set:3:projects/p1/voices/vi/s1/3.pcm',
    ]);
  });

  it('rejects stale translation versions before rate limit and R2 write', async () => {
    const harness = testApp({ current: translation({ version: 4 }) });
    const response = await put(harness.app, harness.env, '/api/projects/p1/translations/vi/s1/voice-pcm', new Uint8Array([0, 0]));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TRANSLATION_VARIANT_CONFLICT' });
    expect(harness.calls).toEqual([
      'project:p1:dev-user',
      'segment:p1:s1:dev-user',
      'translation:get',
    ]);
    expect(harness.stored()).toBeNull();
  });

  it('rejects unsupported language and malformed PCM metadata without repository work', async () => {
    const languageHarness = testApp();
    const unsupported = await put(languageHarness.app, languageHarness.env, '/api/projects/p1/translations/ja/s1/voice-pcm', new Uint8Array([0, 0]));
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'CLIENT_VOICE_LANGUAGE_UNSUPPORTED' });
    expect(languageHarness.calls).toEqual([]);

    const metadataHarness = testApp();
    const malformed = await put(
      metadataHarness.app,
      metadataHarness.env,
      '/api/projects/p1/translations/vi/s1/voice-pcm',
      new Uint8Array([0, 0]),
      { ...validHeaders, 'X-DubFlow-PCM-Sample-Rate': '16000' },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'CLIENT_VOICE_PCM_INVALID' });
    expect(metadataHarness.calls).toEqual([]);
  });

  it('rejects odd and oversized PCM and rate-limited requests before R2 write', async () => {
    const oddHarness = testApp();
    const odd = await put(oddHarness.app, oddHarness.env, '/api/projects/p1/translations/vi/s1/voice-pcm', new Uint8Array([1, 2, 3]));
    expect(odd.status).toBe(400);
    expect(await odd.json()).toMatchObject({ code: 'CLIENT_VOICE_PCM_INVALID' });
    expect(oddHarness.stored()).toBeNull();

    const oversizedHarness = testApp();
    const oversized = await put(
      oversizedHarness.app,
      oversizedHarness.env,
      '/api/projects/p1/translations/vi/s1/voice-pcm',
      new Uint8Array((8 * 1024 * 1024) + 2),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: 'CLIENT_VOICE_PCM_TOO_LARGE' });
    expect(oversizedHarness.stored()).toBeNull();

    const rateHarness = testApp({ limiterSuccess: false });
    const rateLimited = await put(rateHarness.app, rateHarness.env, '/api/projects/p1/translations/vi/s1/voice-pcm', new Uint8Array([0, 0]));
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get('Retry-After')).toBe('60');
    expect(await rateLimited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(rateHarness.stored()).toBeNull();
  });
});
