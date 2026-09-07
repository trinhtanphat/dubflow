import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_READINESS_REVISION, CURRENT_SCHEMA_REVISION, probeDeployment } from '../scripts/verify-deployment.mjs';

test('deployment probe requires HTTP 200 and the exact zero-container readiness/schema revisions', async () => {
  assert.equal(CURRENT_READINESS_REVISION, 2);
  assert.equal(CURRENT_SCHEMA_REVISION, 13);
  const fetchOk = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ready: true,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 13,
        readinessRevision: 2,
        media: { stream: 'ready' },
      };
    },
  });
  assert.deepEqual(await probeDeployment(fetchOk), {
    ok: true,
    status: 200,
    body: {
      ready: true,
      service: 'dubflow',
      database: 'ready',
      schemaRevision: 13,
      readinessRevision: 2,
      media: { stream: 'ready' },
    },
  });
});

test('deployment probe rejects a stale HTTP 200 readiness payload without current schema provenance', async () => {
  const fetchStale = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ready: true, service: 'dubflow', database: 'ready', readinessRevision: 2, media: { stream: 'ready' } };
    },
  });
  const result = await probeDeployment(fetchStale);
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});

test('deployment probe rejects the old configuration-only readiness implementation even at schema 13', async () => {
  const fetchOldReadiness = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ready: true,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 13,
        media: { stream: 'ready' },
      };
    },
  });
  const result = await probeDeployment(fetchOldReadiness);
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});

test('deployment probe rejects a prior schema revision even when the payload says ready', async () => {
  const fetchPrior = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ready: true,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 12,
        readinessRevision: 2,
        media: { stream: 'ready' },
      };
    },
  });
  const result = await probeDeployment(fetchPrior);
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});

test('deployment probe rejects a response without live Stream readiness', async () => {
  const fetchNotReady = async () => ({
    ok: false,
    status: 503,
    async json() {
      return {
        ready: false,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 13,
        readinessRevision: 2,
        media: { stream: 'unavailable' },
      };
    },
  });
  const result = await probeDeployment(fetchNotReady);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
