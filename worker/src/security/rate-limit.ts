import type { Env } from '../env';

export type RateLimitOperation = 'process' | 'export' | 'translate' | 'voice' | 'upload';

const bindingName = {
  process: 'RATE_LIMIT_PROCESS',
  export: 'RATE_LIMIT_EXPORT',
  translate: 'RATE_LIMIT_TRANSLATE',
  voice: 'RATE_LIMIT_VOICE',
  upload: 'RATE_LIMIT_UPLOAD',
} as const satisfies Record<RateLimitOperation, keyof Env>;

export async function checkRateLimit(
  env: Env,
  operation: RateLimitOperation,
  userId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: 60 }> {
  const actor = userId.trim();
  if (!actor) throw new Error('Rate-limit actor is required.');
  const result = await env[bindingName[operation]].limit({ key: `${actor}:${operation}` });
  return { allowed: result.success, retryAfterSeconds: 60 };
}
