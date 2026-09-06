import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Phase 4B defines durable managed voice clone lifecycle', () => {
  const migration = read('migrations/0007_voice_clones.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS voice_clones/);
  for (const status of ['creating', 'verification_required', 'ready', 'failed', 'deleting', 'deleted']) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
  assert.match(migration, /provider_voice_id/);
  assert.match(migration, /consent_version/);
  assert.match(migration, /consented_at/);
});

test('Phase 4B uses a dedicated provider boundary and clone rate limit lane', () => {
  const env = read('worker/src/env.ts');
  const wrangler = read('wrangler.jsonc');
  const provider = read('worker/src/services/voice-clone/elevenlabs.ts');
  const route = read('worker/src/routes/voice-clones.ts');
  assert.match(env, /RATE_LIMIT_VOICE_CLONE/);
  assert.match(wrangler, /RATE_LIMIT_VOICE_CLONE/);
  assert.match(provider, /createInstantClone/);
  assert.match(provider, /deleteClone/);
  assert.match(route, /VOICE_CLONE_CONSENT_REQUIRED/);
  assert.match(route, /VOICE_CLONE_SAMPLE_CLEANUP_FAILED|enrollVoiceClone/);
});

test('Phase 4B capability is explicit instead of a generic cloning claim', () => {
  const api = read('src/features/voice/voiceApi.ts');
  const elevenLabsVoice = read('worker/src/services/voice/elevenlabs.ts');
  const workersAiVoice = read('worker/src/services/voice/workers-ai.ts');
  const route = read('worker/src/routes/voice.ts');
  assert.match(api, /cloneEnrollment/);
  assert.match(api, /mode:\s*'ivc'/);
  assert.match(elevenLabsVoice, /cloneEnrollment/);
  assert.match(elevenLabsVoice, /mode:\s*'ivc'/);
  assert.match(workersAiVoice, /cloneEnrollment:[\s\S]*available:\s*false/);
  assert.match(route, /provider\.capabilities\(\)/);
  assert.match(route, /hasElevenLabsKey/);
});

test('Phase 4B documents consent and no-production boundary', () => {
  const status = read('docs/deployment-status.md');
  assert.match(status, /Phase 4B/);
  assert.match(status, /consent/i);
  assert.match(status, /IVC/);
  assert.match(status, /production.*UNQUALIFIED|UNQUALIFIED.*production/is);
  assert.match(status, /manual-only/i);
});
