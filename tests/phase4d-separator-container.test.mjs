import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const required = [
  'worker/src/services/separation/types.ts',
  'worker/src/services/separation/container.ts',
  'worker/src/containers/SeparatorContainer.ts',
  'containers/separator/Dockerfile',
  'containers/separator/server.mjs',
];

test('Phase 4D uses a dedicated offline separator with pinned model provenance', () => {
  for (const path of required) assert.ok(existsSync(path), `${path} must exist`);

  const types = readFileSync('worker/src/services/separation/types.ts', 'utf8');
  assert.match(types, /interface AudioSeparationProvider/);
  assert.match(types, /qualified:\s*boolean/);
  assert.match(types, /modelDigest:\s*string/);

  const container = readFileSync('worker/src/containers/SeparatorContainer.ts', 'utf8');
  assert.match(container, /enableInternet\s*=\s*false/);
  assert.match(container, /media\.r2/);

  const docker = readFileSync('containers/separator/Dockerfile', 'utf8');
  assert.match(docker, /DEMUCS_VERSION=4\.0\.1/);
  assert.match(docker, /955717e8-8726e21a\.th/);
  assert.match(docker, /MODEL_HASH=8726e21a/);
  assert.match(docker, /sha256sum/);

  const server = readFileSync('containers/separator/server.mjs', 'utf8');
  assert.doesNotMatch(server, /dl\.fbaipublicfiles\.com|huggingface\.co/);
  assert.match(server, /\/separate/);
});
