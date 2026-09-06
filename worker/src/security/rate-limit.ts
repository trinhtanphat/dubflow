import type { Context } from 'hono';
import type { Env, RateLimitBindingLike } from '../env';
import { errorBody } from '../http/json';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';

export type RateLimitOperation = 'process' | 'export' | 'translate' | 'voice' | 'upload' | 'voice-clone' | 'batch-export' | 'separation';

function bindingFor(env: Env, operation: RateLimitOperation): RateLimitBindingLike {
  const bindings: Record<RateLimitOperation, RateLimitBindingLike> = {
    process: env.RATE_LIMIT_PROCESS,
    export: env.RATE_LIMIT_EXPORT,
    translate: env.RATE_LIMIT_TRANSLATE,
    voice: env.RATE_LIMIT_VOICE,
    upload: env.RATE_LIMIT_UPLOAD,
    'voice-clone': env.RATE_LIMIT_VOICE_CLONE,
    'batch-export': env.RATE_LIMIT_BATCH_EXPORT,
    separation: env.RATE_LIMIT_SEPARATION,
  };
  return bindings[operation];
}

export async function checkRateLimit(
  env: Env,
  operation: RateLimitOperation,
  userId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: 60 }> {
  const actor = userId.trim();
  if (!actor) throw new Error('Rate-limit actor is required.');
  const result = await bindingFor(env, operation).limit({ key: `${actor}:${operation}` });
  return { allowed: result.success, retryAfterSeconds: 60 };
}

function effectiveOperation(c: Context<any>, operation: RateLimitOperation): RateLimitOperation {
  // Main already shipped a dedicated batch-export admission budget. The canonical Phase 4C
  // reconciliation keeps batch fan-out inside the export router, so preserve that budget at
  // the shared limiter boundary instead of consuming both batch and single-export quotas.
  if (operation === 'export' && c.req.path.endsWith('/exports/batch')) return 'batch-export';
  return operation;
}

export async function enforceRateLimit(
  c: Context<any>,
  operation: RateLimitOperation,
  userId: string,
  projectId?: string,
): Promise<Response | null> {
  const admittedOperation = effectiveOperation(c, operation);
  const decision = await checkRateLimit(c.env as Env, admittedOperation, userId);
  if (decision.allowed) return null;

  let requestId: string | undefined;
  try {
    requestId = c.get('requestId') as string | undefined;
  } catch {
    requestId = undefined;
  }
  emitTelemetry(createTelemetry(c.env as Env), {
    name: 'rate_limited',
    requestId,
    actorId: userId,
    projectId,
    operation: admittedOperation,
    status: 'rejected',
    httpStatus: 429,
  });
  c.header('Retry-After', String(decision.retryAfterSeconds));
  return c.json(errorBody('RATE_LIMITED', `Too many ${admittedOperation} requests.`), 429);
}
