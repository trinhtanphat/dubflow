import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_REVISION, probeDeployment } from '../scripts/verify-deployment.mjs';

test('deployment probe requires HTTP 200 and the exact zero-container schema revision 12', async () => {
  assert.equal(CURRENT_SCHEMA_REVISION, 12);
  const fetchOk = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready', schemaRevision: 12 };
    },
  });
  assert.deepEqual(await probeDeployment(fetchOk), {
    ok: true,
    status: 200,
    body: { ready: true, service: 'dubflow', database: 'ready', schemaRevision: 12 },
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

test('deployment probe rejects a prior schema revision even when the payload says ready', async () => {
  const fetchPrior = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready', schemaRevision: 11 };
    },
  });
  const result = await probeDeployment(fetchPrior);
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
