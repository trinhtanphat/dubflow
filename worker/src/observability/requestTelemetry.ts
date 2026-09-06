import type { Context, Next } from 'hono';
import { routePath } from 'hono/route';
import type { Env } from '../env';
import { getCurrentUserId } from '../security/current-user';
import { createTelemetry, emitTelemetry, type TelemetrySink } from './telemetry';

export type WorkerHonoEnv = {
  Bindings: Env;
  Variables: { requestId: string };
};

export function requestTelemetryMiddleware(
  makeSink: (env: Env) => TelemetrySink = createTelemetry,
) {
  return async (c: Context<WorkerHonoEnv>, next: Next) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    c.set('requestId', requestId);

    await next();

    c.header('x-request-id', requestId);
    emitTelemetry(makeSink(c.env), {
      name: 'request_completed',
      requestId,
      actorId: getCurrentUserId(),
      method: c.req.method,
      route: routePath(c, -1),
      httpStatus: c.res.status,
      durationMs: Date.now() - started,
      status: c.res.status < 500 ? 'completed' : 'failed',
    });
  };
}
