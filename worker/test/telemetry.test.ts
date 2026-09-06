import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import {
  createTelemetry,
  emitTelemetry,
  withProviderTelemetry,
  type TelemetryEvent,
  type TelemetrySink,
} from '../src/observability/telemetry';
import { requestTelemetryMiddleware, type WorkerHonoEnv } from '../src/observability/requestTelemetry';

function recordingSink(events: TelemetryEvent[]): TelemetrySink {
  return { write(event) { events.push(event); } };
}

describe('Phase 3C telemetry', () => {
  it('encodes normalized Analytics Engine datapoints without arbitrary sensitive payloads', () => {
    const points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
    const telemetry = createTelemetry({
      ANALYTICS: {
        writeDataPoint(point) { points.push(point); },
      },
    } as Pick<Env, 'ANALYTICS'>);

    emitTelemetry(telemetry, {
      name: 'rate_limited',
      requestId: 'req-1',
      actorId: 'user-1',
      projectId: 'p1',
      operation: 'process',
      status: 'rejected',
      httpStatus: 429,
      durationMs: 12,
    });

    expect(points).toHaveLength(1);
    expect(points[0]?.blobs).toEqual([
      'rate_limited', 'req-1', 'user-1', 'p1', '', '', 'process', '', 'rejected', '', '', '', '',
    ]);
    expect(points[0]?.doubles).toEqual([429, 12, 0]);
    expect(points[0]?.indexes).toEqual(['user-1']);
    expect(JSON.stringify(points[0])).not.toMatch(/transcript|sourceText|translatedText|authorization|cookie|api[_-]?key|token=/i);
  });

  it('preserves provider errors while emitting only a normalized failure code', async () => {
    const events: TelemetryEvent[] = [];
    const secretError = new Error('provider body contains secret transcript and sk-live-key');

    await expect(withProviderTelemetry(
      recordingSink(events),
      {
        requestId: 'req-2',
        actorId: 'user-1',
        projectId: 'p1',
        operation: 'translate',
        provider: 'workers-ai',
        errorCode: 'TRANSLATION_PROVIDER_FAILED',
      },
      async () => { throw secretError; },
    )).rejects.toBe(secretError);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      name: 'provider_failure',
      requestId: 'req-2',
      provider: 'workers-ai',
      errorCode: 'TRANSLATION_PROVIDER_FAILED',
      status: 'failure',
    }));
    expect(JSON.stringify(events[0])).not.toContain(secretError.message);
  });

  it('swallows telemetry sink failures after a sanitized marker', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => emitTelemetry({ write() { throw new Error('analytics secret'); } }, {
      name: 'request_completed',
      requestId: 'req-3',
      status: 'completed',
      httpStatus: 200,
    })).not.toThrow();
    expect(error).toHaveBeenCalledWith('telemetry_write_failed');
    error.mockRestore();
  });

  it('generates a server request id and emits a route template without the share query token', async () => {
    const events: TelemetryEvent[] = [];
    const app = new Hono<WorkerHonoEnv>();
    app.use('/api/*', requestTelemetryMiddleware(() => recordingSink(events)));
    app.get('/api/shares/:shareId/media', (c) => c.text('ok'));

    const response = await app.request(
      '/api/shares/share-1/media?token=super-secret-token',
      {},
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(events).toContainEqual(expect.objectContaining({
      name: 'request_completed',
      method: 'GET',
      route: '/api/shares/:shareId/media',
      httpStatus: 200,
    }));
    expect(JSON.stringify(events)).not.toContain('super-secret-token');
    expect(JSON.stringify(events)).not.toContain('?token=');
  });
});
