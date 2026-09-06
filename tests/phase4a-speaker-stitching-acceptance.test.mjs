import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Phase 4A wires bounded overlapping ASR windows', () => {
  const mediaClient = source('worker/src/services/media/container.ts');
  const containerServer = source('containers/ffmpeg/server.mjs');

  assert.match(mediaClient, /chunkSeconds:\s*300/);
  assert.match(mediaClient, /overlapSeconds:\s*8/);
  assert.match(containerServer, /overlapSeconds/);
  assert.match(containerServer, /chunkSeconds\s*-\s*overlapSeconds/);
  assert.match(containerServer, /overlapSeconds[^\n]*30|30[^\n]*overlapSeconds/);
});

test('Phase 4A uses a dedicated conservative speaker stitching boundary', () => {
  const stitch = source('worker/src/services/asr/stitch.ts');
  const pipeline = source('worker/src/workflows/pipeline.ts');

  assert.match(stitch, /export function stitchAsrChunks/);
  assert.match(stitch, /speakerIndex/);
  assert.match(stitch, /unique|ambiguous|candidate/i);
  assert.match(stitch, /normalize\('NFKC'\)/);
  assert.match(stitch, /1500/);
  assert.match(pipeline, /stitchAsrChunks/);
});

test('Phase 4A keeps production runtime truthfully unqualified', () => {
  const status = source('docs/deployment-status.md');
  const readme = source('README.md');
  const workflow = source('.github/workflows/deploy-cloudflare.yml');

  assert.match(status, /Phase 4A/);
  assert.match(status, /UNQUALIFIED/);
  assert.match(readme, /cross-chunk|speaker stitching/i);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:/);
});

test('Phase 4A acceptance runs inside deploy-config verification', () => {
  const pkg = JSON.parse(source('package.json'));
  assert.match(pkg.scripts['verify:deploy-config'], /phase4a-speaker-stitching-acceptance\.test\.mjs/);
});
