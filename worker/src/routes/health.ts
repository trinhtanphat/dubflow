export type HealthPayload = {
  ok: true;
  service: 'dubflow';
  phase: 'foundation';
};

export function healthPayload(): HealthPayload {
  return {
    ok: true,
    service: 'dubflow',
    phase: 'foundation',
  };
}
