import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const audioChunks = read('containers/ffmpeg/audio-chunks.mjs');
const mediaTypes = read('worker/src/services/media/types.ts');
const mediaContainer = read('worker/src/services/media/container.ts');
const stitch = read('worker/src/services/asr/stitch.ts');
const reconcile = read('worker/src/services/asr/reconcile.ts');
const pipeline = read('worker/src/workflows/pipeline.ts');
const segmentStore = read('worker/src/db/segments.ts');
const deploymentStatus = read('docs/deployment-status.md');

function assertInOrder(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.notEqual(index, -1, `missing ordered source marker: ${marker}`);
    assert.ok(index > previous, `source marker is out of order: ${marker}`);
    previous = index;
  }
}

test('Phase 4A pins fixed overlapping media chunks and strict Worker metadata', () => {
  assert.match(audioChunks, /AUDIO_CHUNK_MS\s*=\s*300_000/);
  assert.match(audioChunks, /AUDIO_CHUNK_OVERLAP_MS\s*=\s*15_000/);
  assert.match(audioChunks, /chunkMs\s*-\s*overlapMs/);
  assert.match(mediaTypes, /overlapBeforeMs:\s*number/);
  assert.match(mediaTypes, /overlapAfterMs:\s*number/);
  assert.match(mediaContainer, /chunk\.overlapBeforeMs/);
  assert.match(mediaContainer, /chunk\.overlapAfterMs/);
  assert.doesNotMatch(mediaContainer, /chunkSeconds/);
});

test('Phase 4A locks conservative deterministic stitch and rerun reconciliation thresholds', () => {
  assert.match(stitch, /1_500|1500/);
  assert.match(stitch, /750/);
  assert.match(stitch, /mutual|leftBest|rightBest/);
  assert.match(reconcile, /2_000|2000/);
  assert.match(reconcile, /existingSpeakerId/);
  assert.doesNotMatch(stitch + reconcile, /embedding|voiceprint|biometric/i);
});

test('Phase 4A stitches only after ASR and before destructive replacement while preserving provider usage units', () => {
  assert.match(pipeline, /chunk\.durationMs\s*\/\s*1000/);
  assertInOrder(pipeline, [
    'stitchInputs.push',
    'load existing speaker coverage',
    'stitchAsrChunks(stitchInputs)',
    'reconcileSpeakerIds(stitched',
    'replaceFromAsr(params.projectId, params.userId, normalized)',
  ]);
  assert.match(segmentStore, /ON CONFLICT\(id\) DO NOTHING/);
});

test('Phase 4A requires no new D1 migration or biometric identity store', () => {
  const migrations = readdirSync('migrations').filter((name) => name.endsWith('.sql'));
  assert.equal(migrations.some((name) => /^0007/.test(name)), false);
  assert.doesNotMatch(stitch + reconcile + segmentStore, /voiceprint|biometric template|speaker embedding/i);
});

test('Phase 4A deployment status records source qualification without upgrading runtime', () => {
  assert.match(deploymentStatus, /## Phase 4A .*qualification/i);
  assert.match(deploymentStatus, /300(?:-second|s).*15(?:-second|s).*overlap/is);
  assert.match(deploymentStatus, /project-stable speaker/i);
  assert.match(deploymentStatus, /rerun/i);
  assert.match(deploymentStatus, /voice.*mapping|voice assignment/i);
  assert.match(deploymentStatus, /no biometric|without biometric/i);
  assert.match(deploymentStatus, /Phase 3B.*usage/i);
  assert.match(deploymentStatus, /runtime (?:status )?remains \*\*UNQUALIFIED\*\*/i);
  assert.doesNotMatch(deploymentStatus, /speaker identities are currently \*\*chunk-scoped\*\*/i);
});
