import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');
const wranglerConfig = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('Cloudflare deployment is manual-only while container credentials are externally qualified', () => {
  assert.doesNotMatch(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
});

test('production deploy uses the same Cloudflare account as Wrangler', () => {
  const match = workflow.match(/CLOUDFLARE_ACCOUNT_ID:\s*([0-9a-f]{32})/i);
  assert.ok(match, 'deployment workflow must declare CLOUDFLARE_ACCOUNT_ID');
  assert.equal(match[1], wranglerConfig.account_id);
});

test('production deploy wires optional translation, diarization and ElevenLabs voice secrets without committing values', () => {
  assert.match(workflow, /GOOGLE_CLOUD_TRANSLATE_API_KEY:\s*\$\{\{ secrets\.GOOGLE_CLOUD_TRANSLATE_API_KEY \}\}/);
  assert.match(workflow, /DEEPGRAM_API_KEY:\s*\$\{\{ secrets\.DEEPGRAM_API_KEY \}\}/);
  assert.match(workflow, /ELEVENLABS_API_KEY:\s*\$\{\{ secrets\.ELEVENLABS_API_KEY \}\}/);
  assert.match(workflow, /ELEVENLABS_DEFAULT_VOICE_ID:\s*\$\{\{ secrets\.ELEVENLABS_DEFAULT_VOICE_ID \}\}/);
  assert.match(workflow, /wrangler secret put DEEPGRAM_API_KEY/);
  assert.match(workflow, /wrangler secret put ELEVENLABS_API_KEY/);
  assert.match(workflow, /wrangler secret put ELEVENLABS_DEFAULT_VOICE_ID/);
  assert.doesNotMatch(workflow, /Authorization:\s*Token\s+[A-Za-z0-9]/i);
  assert.doesNotMatch(workflow, /xi-api-key:\s*[A-Za-z0-9]/i);
});
