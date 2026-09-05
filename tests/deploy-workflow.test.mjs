import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('Cloudflare deployment is manual-only while container credentials are externally qualified', () => {
  assert.doesNotMatch(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
});

test('production deploy wires optional translation and ElevenLabs voice secrets without committing values', () => {
  assert.match(workflow, /GOOGLE_CLOUD_TRANSLATE_API_KEY:\s*\$\{\{ secrets\.GOOGLE_CLOUD_TRANSLATE_API_KEY \}\}/);
  assert.match(workflow, /ELEVENLABS_API_KEY:\s*\$\{\{ secrets\.ELEVENLABS_API_KEY \}\}/);
  assert.match(workflow, /ELEVENLABS_DEFAULT_VOICE_ID:\s*\$\{\{ secrets\.ELEVENLABS_DEFAULT_VOICE_ID \}\}/);
  assert.match(workflow, /wrangler secret put ELEVENLABS_API_KEY/);
  assert.match(workflow, /wrangler secret put ELEVENLABS_DEFAULT_VOICE_ID/);
  assert.doesNotMatch(workflow, /xi-api-key:\s*[A-Za-z0-9]/i);
});
