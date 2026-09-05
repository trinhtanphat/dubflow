import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDeployment } from '../scripts/verify-deployment.mjs';

test('deployment probe requires HTTP 200 and ready payload', async () => {
  const fetchOk = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready' };
    },
  });
  assert.deepEqual(await probeDeployment(fetchOk), {
    ok: true,
    status: 200,
    body: { ready: true, service: 'dubflow', database: 'ready' },
  });
});

test('deployment probe rejects a response without database readiness', async () => {
  const fetchNotReady = async () => ({
    ok: false,
    status: 503,
    async json() {
      return { ready: false, service: 'dubflow', database: 'missing-schema' };
    },
  });
  const result = await probeDeployment(fetchNotReady);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
