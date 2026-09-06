import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const audioChunks = read('containers/ffmpeg/audio-chunks.mjs');
const mediaTypes = read('worker/src/services/media/types.ts');
const stitch = read('worker/src/services/asr/stitch.ts');
const reconcile = read('worker/src/services/asr/reconcile.ts');
const pipeline = read('worker/src/workflows/pipeline.ts');
const packageJson = read('package.json');
const deploymentStatus = read('docs/deployment-status.md');

test('Phase 4A cross-chunk stitching uses the superseding 300s/15s fixed window contract', () => {
  assert.match(audioChunks, /AUDIO_CHUNK_MS\s*=\s*300_000/);
  assert.match(audioChunks, /AUDIO_CHUNK_OVERLAP_MS\s*=\s*15_000/);
  assert.match(mediaTypes, /overlapBeforeMs:\s*number/);
  assert.match(mediaTypes, /overlapAfterMs:\s*number/);
});

test('Phase 4A keeps conservative deterministic speaker evidence and rerun reconciliation', () => {
  assert.match(stitch, /NFKC/);
  assert.match(stitch, /1_500|1500/);
  assert.match(stitch, /750/);
  assert.match(stitch, /leftBest/);
  assert.match(stitch, /rightBest/);
  assert.match(reconcile, /2_000|2000/);
  assert.match(pipeline, /stitchAsrChunks\(stitchInputs\)/);
  assert.match(pipeline, /reconcileSpeakerIds\(stitched/);
  assert.doesNotMatch(stitch + reconcile, /embedding|voiceprint|biometric/i);
});

test('Phase 4A source gates expose only the 15-second canonical window policy and runtime stays unqualified', () => {
  assert.match(packageJson, /phase4a-speaker-stitching-acceptance\.test\.mjs/);
  assert.match(packageJson, /phase4a-diarization-acceptance\.test\.mjs/);
  assert.match(packageJson, /audio-chunks\.test\.mjs/);
  assert.doesNotMatch(packageJson, /audio-windows\.test\.mjs/);
  assert.match(deploymentStatus, /300(?:-second|s).*15(?:-second|s).*overlap/is);
  assert.match(deploymentStatus, /285(?:-second|s)/is);
  assert.match(deploymentStatus, /rerun/i);
  assert.match(deploymentStatus, /Production runtime remains \*\*UNQUALIFIED\*\*/i);
});
