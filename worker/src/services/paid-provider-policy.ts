export type PaidElevenLabsEnv = {
  PAID_ELEVENLABS_ENABLED?: string;
};

export function paidElevenLabsEnabled(env: PaidElevenLabsEnv): boolean {
  return env.PAID_ELEVENLABS_ENABLED === 'true';
}
