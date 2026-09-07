import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_REVISION, probeDeployment } from '../scripts/verify-deployment.mjs';

const readyBody = {
  ready: true,
  service: 'dubflow',
  database: 'ready',
  schemaRevision: 14,
  asr: {
    provider: 'deepgram-nova-3',
    speakerDiarization: 'configured',
    speakerIdentityScope: 'chunk',
  },
  voice: { provider: 'elevenlabs', configured: true },
  media: { r2: 'ready', remux: 'ready' },
};

test('deployment probe requires HTTP 200, schema revision 14, providers, and R2/remux readiness', async () => {
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
      return { ...readyBody, schemaRevision: undefined };
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

test('deployment probe rejects unavailable remote ASR even when media readiness is green', async () => {
  const fetchFallbackAsr = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ...readyBody,
        asr: {
          provider: 'workers-ai-whisper-large-v3-turbo',
          speakerDiarization: 'unavailable',
          speakerIdentityScope: 'none',
        },
      };
    },
  });
  assert.equal((await probeDeployment(fetchFallbackAsr)).ok, false);
});

test('deployment probe rejects unavailable production voice configuration', async () => {
  const fetchVoiceUnavailable = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...readyBody, voice: { provider: 'elevenlabs', configured: false } };
    },
  });
  assert.equal((await probeDeployment(fetchVoiceUnavailable)).ok, false);
});

test('deployment probe rejects Stream-shaped or unavailable media readiness', async () => {
  const fetchStream = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...readyBody, media: { stream: 'ready' } };
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
