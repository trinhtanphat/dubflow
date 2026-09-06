import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import type { Env } from '../src/env';
import { requestTelemetryMiddleware, type WorkerHonoEnv } from '../src/observability/requestTelemetry';
import { createTranslationRoutes } from '../src/routes/translation';
import { createVoiceRoutes } from '../src/routes/voice';

type AnalyticsPoint = { blobs?: string[]; doubles?: number[]; indexes?: string[] };

type SegmentRow = {
  id: string;
  project_id: string;
  speaker_id: string | null;
  start_ms: number;
  end_ms: number;
  source_text: string;
  translated_text: string;
  translation_engine: string;
  translation_status: string;
  voice_status: string;
  version: number;
  split_parent_id: string | null;
};

class Statement implements D1StatementLike {
  values: unknown[] = [];
  constructor(private readonly db: FakeDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async run(): Promise<D1RunResultLike> {
    if (this.sql.includes('UPDATE segments SET translated_text')) {
      this.db.segment.translated_text = String(this.values[0]);
      this.db.segment.translation_engine = String(this.values[1]);
      this.db.segment.translation_status = 'completed';
      this.db.segment.version += 1;
    }
    return { meta: { changes: 1 } };
  }
  async all<T>() { return { results: [] as T[] }; }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM projects WHERE id = ? AND user_id = ?')) {
      return {
        id: 'p1', user_id: 'dev-user', title: 'demo', source_language: 'en', target_language: 'vi', status: 'needs_review',
      } as T;
    }
    if (this.sql.includes('FROM segments s JOIN projects p')) return { ...this.db.segment } as T;
    return null;
  }
}

class FakeDb implements D1DatabaseLike {
  segment: SegmentRow = {
    id: 's1', project_id: 'p1', speaker_id: null, start_ms: 0, end_ms: 1_000,
    source_text: 'secret source sentence', translated_text: 'old', translation_engine: 'workers-ai',
    translation_status: 'completed', voice_status: 'pending', version: 2, split_parent_id: null,
  };
  prepare(sql: string) { return new Statement(this, sql); }
}

function analytics(points: AnalyticsPoint[]) {
  return { writeDataPoint(point: AnalyticsPoint) { points.push(point); } } as Env['ANALYTICS'];
}

function providerEvents(points: AnalyticsPoint[]) {
  return points.filter((point) => point.blobs?.[0] === 'provider_success' || point.blobs?.[0] === 'provider_failure');
}

function translationApp() {
  const app = new Hono<WorkerHonoEnv>();
  app.use('/api/*', requestTelemetryMiddleware());
  app.route('/api/projects', createTranslationRoutes());
  return app;
}

function translationEnv(points: AnalyticsPoint[], run: Env['AI']['run']): Env {
  return {
    DB: new FakeDb(),
    AI: { run },
    ANALYTICS: analytics(points),
    RATE_LIMIT_TRANSLATE: { async limit() { return { success: true }; } },
    GOOGLE_CLOUD_TRANSLATE_API_KEY: 'google-test-key',
  } as unknown as Env;
}

function voiceApp(fetcher: typeof fetch) {
  const app = new Hono<WorkerHonoEnv>();
  app.use('/api/*', requestTelemetryMiddleware());
  app.route('/api/voice', createVoiceRoutes(fetcher));
  return app;
}

function voiceEnv(points: AnalyticsPoint[]): Env {
  return {
    AI: { async run() { return {}; } },
    ANALYTICS: analytics(points),
    RATE_LIMIT_VOICE: { async limit() { return { success: true }; } },
    ELEVENLABS_API_KEY: 'voice-test-key',
    ELEVENLABS_DEFAULT_VOICE_ID: 'voice-1',
  } as unknown as Env;
}

describe('Phase 3C direct provider telemetry', () => {
  it('emits correlated translation provider success without source text', async () => {
    const points: AnalyticsPoint[] = [];
    const response = await translationApp().request('/api/projects/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' }),
    }, translationEnv(points, async () => ({ translated_text: 'translated result' })));

    expect(response.status).toBe(200);
    const events = providerEvents(points);
    expect(events).toHaveLength(1);
    expect(events[0]?.blobs?.[0]).toBe('provider_success');
    expect(events[0]?.blobs?.[1]).toBeTruthy();
    expect(events[0]?.blobs?.[2]).toBe('dev-user');
    expect(events[0]?.blobs?.[3]).toBe('p1');
    expect(events[0]?.blobs?.[6]).toBe('translate');
    expect(events[0]?.blobs?.[7]).toBe('workers-ai');
    expect(JSON.stringify(events)).not.toContain('secret source sentence');
    expect(JSON.stringify(events)).not.toContain('translated result');
  });

  it('emits normalized translation provider failure without raw provider error', async () => {
    const points: AnalyticsPoint[] = [];
    const response = await translationApp().request('/api/projects/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' }),
    }, translationEnv(points, async () => { throw new Error('raw provider secret response'); }));

    expect(response.status).toBeGreaterThanOrEqual(500);
    const events = providerEvents(points);
    expect(events).toHaveLength(1);
    expect(events[0]?.blobs?.[0]).toBe('provider_failure');
    expect(events[0]?.blobs?.[6]).toBe('translate');
    expect(events[0]?.blobs?.[7]).toBe('workers-ai');
    expect(events[0]?.blobs?.[9]).toBe('TRANSLATION_PROVIDER_FAILED');
    expect(JSON.stringify(events)).not.toContain('raw provider secret response');
  });

  it('emits correlated ElevenLabs preview success without preview text', async () => {
    const points: AnalyticsPoint[] = [];
    const response = await voiceApp(async () => new Response('audio', { headers: { 'content-type': 'audio/mpeg' } })).request('/api/voice/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'private preview sentence', language: 'vi' }),
    }, voiceEnv(points));

    expect(response.status).toBe(200);
    const events = providerEvents(points);
    expect(events).toHaveLength(1);
    expect(events[0]?.blobs?.[0]).toBe('provider_success');
    expect(events[0]?.blobs?.[1]).toBeTruthy();
    expect(events[0]?.blobs?.[2]).toBe('dev-user');
    expect(events[0]?.blobs?.[6]).toBe('voice-preview');
    expect(events[0]?.blobs?.[7]).toBe('elevenlabs');
    expect(JSON.stringify(events)).not.toContain('private preview sentence');
  });

  it('emits normalized ElevenLabs preview failure without raw provider error', async () => {
    const points: AnalyticsPoint[] = [];
    const response = await voiceApp(async () => { throw new Error('raw elevenlabs secret failure'); }).request('/api/voice/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'private preview sentence', language: 'vi' }),
    }, voiceEnv(points));

    expect(response.status).toBeGreaterThanOrEqual(500);
    const events = providerEvents(points);
    expect(events).toHaveLength(1);
    expect(events[0]?.blobs?.[0]).toBe('provider_failure');
    expect(events[0]?.blobs?.[6]).toBe('voice-preview');
    expect(events[0]?.blobs?.[7]).toBe('elevenlabs');
    expect(events[0]?.blobs?.[9]).toBe('VOICE_PROVIDER_FAILED');
    expect(JSON.stringify(events)).not.toContain('raw elevenlabs secret failure');
  });
});
