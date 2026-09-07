import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_REVISION, probeDeployment } from '../scripts/verify-deployment.mjs';

const readyBody = {
  ready: true,
  service: 'dubflow',
  database: 'ready',
  schemaRevision: 14,
  media: { r2: 'ready', remux: 'ready' },
  voice: { provider: 'elevenlabs', status: 'ready' },
};

test('deployment probe requires HTTP 200, schema revision 14, R2/remux readiness, and configured dubbing voice', async () => {
  assert.equal(CURRENT_SCHEMA_REVISION, 14);
  const fetchOk = async () => ({
    ok: true,
    status: 200,
    async json() { return readyBody; },
  });
  assert.deepEqual(await probeDeployment(fetchOk), { ok: true, status: 200, body: readyBody });
});

test('deployment probe rejects a stale HTTP 200 readiness payload without current schema provenance', async () => {
  const fetchStale = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ready: true,
        service: 'dubflow',
        database: 'ready',
        media: { r2: 'ready', remux: 'ready' },
        voice: { provider: 'elevenlabs', status: 'ready' },
      };
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
      return { ...readyBody, schemaRevision: 13 };
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
      return { ...readyBody, ready: false, database: 'missing-schema', schemaRevision: null };
    },
  });
  const result = await probeDeployment(fetchNotReady);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('deployment probe rejects Stream-shaped or unavailable media readiness', async () => {
  const fetchStream = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ready: true,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 14,
        media: { stream: 'ready' },
        voice: { provider: 'elevenlabs', status: 'ready' },
      };
    },
  });
  assert.equal((await probeDeployment(fetchStream)).ok, false);

  const fetchRemuxUnavailable = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...readyBody, media: { r2: 'ready', remux: 'unavailable' } };
    },
  });
  assert.equal((await probeDeployment(fetchRemuxUnavailable)).ok, false);
});

test('deployment probe rejects false-green readiness when the standard dubbing voice provider is missing or unavailable', async () => {
  const fetchMissingVoice = async () => ({
    ok: true,
    status: 200,
    async json() {
      const { voice: _voice, ...withoutVoice } = readyBody;
      return withoutVoice;
    },
  });
  assert.equal((await probeDeployment(fetchMissingVoice)).ok, false);

  const fetchUnavailableVoice = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...readyBody, voice: { provider: 'elevenlabs', status: 'unavailable' } };
    },
  });
  assert.equal((await probeDeployment(fetchUnavailableVoice)).ok, false);
});
