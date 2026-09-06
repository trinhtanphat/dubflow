import type { Context } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../http/json';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';

export type RateLimitOperation = 'process' | 'export' | 'translate' | 'voice' | 'upload' | 'voice-clone' | 'batch-export';

const bindingName = {
  process: 'RATE_LIMIT_PROCESS',
  export: 'RATE_LIMIT_EXPORT',
  translate: 'RATE_LIMIT_TRANSLATE',
  voice: 'RATE_LIMIT_VOICE',
  upload: 'RATE_LIMIT_UPLOAD',
  'voice-clone': 'RATE_LIMIT_VOICE_CLONE',
  'batch-export': 'RATE_LIMIT_BATCH_EXPORT',
} as const satisfies Record<RateLimitOperation, keyof Env>;

export async function checkRateLimit(env: Env, operation: RateLimitOperation, userId: string): Promise<{ allowed: boolean; retryAfterSeconds: 60 }> {
  const actor = userId.trim();
  if (!actor) throw new Error('Rate-limit actor is required.');
  const result = await env[bindingName[operation]].limit({ key: `${actor}:${operation}` });
  return { allowed: result.success, retryAfterSeconds: 60 };
}

export async function enforceRateLimit(c: Context<any>, operation: RateLimitOperation, userId: string, projectId?: string): Promise<Response | null> {
  const decision = await checkRateLimit(c.env as Env, operation, userId);
  if (decision.allowed) return null;
  let requestId: string | undefined;
  try { requestId = c.get('requestId') as string | undefined; } catch { requestId = undefined; }
  emitTelemetry(createTelemetry(c.env as Env), {
    name: 'rate_limited', requestId, actorId: userId, projectId, operation, status: 'rejected', httpStatus: 429,
  });
  c.header('Retry-After', String(decision.retryAfterSeconds));
  return c.json(errorBody('RATE_LIMITED', `Too many ${operation} requests.`), 429);
}
