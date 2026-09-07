import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const r2SourceMedia = read('worker/src/services/media/r2-source.ts');
const stitch = read('worker/src/services/asr/stitch.ts');
const reconcile = read('worker/src/services/asr/reconcile.ts');
const pipeline = read('worker/src/workflows/pipeline.ts');
const packageJson = read('package.json');
const deploymentStatus = read('docs/deployment-status.md');

test('Phase 4A speaker reconciliation accepts the zero-overlap R2 remote-ASR source as one deterministic stitch input', () => {
  assert.match(r2SourceMedia, /prepareSource\(/);
  assert.match(pipeline, /chunkId:\s*`source:\$\{source\.sourceId\}`/);
  assert.match(pipeline, /chunkOrder:\s*0/);
  assert.match(pipeline, /offsetMs:\s*0/);
  assert.match(pipeline, /overlapBeforeMs:\s*0/);
  assert.match(pipeline, /overlapAfterMs:\s*0/);
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

test('Phase 4A source gates no longer require the deleted FFmpeg chunk runtime and runtime stays unqualified', () => {
  assert.match(packageJson, /phase4a-speaker-stitching-acceptance\.test\.mjs/);
  assert.match(packageJson, /phase4a-diarization-acceptance\.test\.mjs/);
  assert.doesNotMatch(packageJson, /audio-chunks\.test\.mjs|containers\/ffmpeg|@cloudflare\/containers/);
  assert.match(deploymentStatus, /Phase 4A/i);
  assert.match(deploymentStatus, /Production runtime remains \*\*UNQUALIFIED\*\*/i);
});
