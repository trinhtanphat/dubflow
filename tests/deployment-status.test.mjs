import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');

test('deployment status documents the split public gateway and backend state ownership', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /50afb4fd3c4c7a1f3e1bdb7f22d4af7f/);
  assert.match(status, /6c5207813df3d5b83b9508125e0e9e12/);
  assert.match(status, /gateway/i);
  assert.match(status, /persisted projects|production data|D1\/R2/i);
  assert.match(status, /Containers.*disabled|disabled.*Containers/is);
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /GitHub Actions is CI only/i);
  assert.match(policy, /must not deploy production/i);
  assert.match(policy, /main/);
});

test('deployment status describes schema-13 zero-container Stream and optional lip-sync paths', () => {
  assert.match(status, /current zero-container source path/i);
  assert.match(status, /Cloudflare Stream/i);
  assert.match(status, /remote ASR/i);
  assert.match(status, /PCM|WAV/i);
  assert.match(status, /schema revision \*\*13\*\*|schema revision 13/i);
  assert.match(status, /FFmpeg Container.*removed|removed.*FFmpeg Container/is);
  assert.match(status, /soundtracks\/\{targetLanguage\}\/\{exportId\}\.wav/);
  assert.match(status, /\.lipsync\.mp4/);
});
