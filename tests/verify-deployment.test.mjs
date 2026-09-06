import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDeployment } from '../scripts/verify-deployment.mjs';

test('deployment probe requires HTTP 200 and the exact current schema revision', async () => {
  const fetchOk = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready', schemaRevision: 10 };
    },
  });
  assert.deepEqual(await probeDeployment(fetchOk), {
    ok: true,
    status: 200,
    body: { ready: true, service: 'dubflow', database: 'ready', schemaRevision: 10 },
  });
});

test('deployment probe rejects a stale HTTP 200 readiness payload without current schema provenance', async () => {
  const fetchStale = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready' };
    },
  });
  const result = await probeDeployment(fetchStale);
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});

test('deployment probe rejects a response without database readiness', async () => {
  const fetchNotReady = async () => ({
    ok: false,
    status: 503,
    async json() {
      return { ready: false, service: 'dubflow', database: 'missing-schema', schemaRevision: null };
    },
  });
  const result = await probeDeployment(fetchNotReady);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
