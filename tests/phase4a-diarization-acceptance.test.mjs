import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const r2SourceMedia = read('worker/src/services/media/r2-source.ts');
const deepgram = read('worker/src/services/asr/deepgram.ts');
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

test('Phase 4A diarization enters through signed R2 remote ASR without Stream or FFmpeg chunk extraction', () => {
  assert.match(r2SourceMedia, /prepareSource\(/);
  assert.match(r2SourceMedia, /\/api\/media-source\//);
  assert.match(deepgram, /transcribeUrl\(/);
  assert.match(pipeline, /sourceMedia\.prepareSource|sourceMedia!\.prepareSource/);
  assert.match(pipeline, /transcribeUrl\(source\.audioUrl/);
  assert.match(pipeline, /source\.durationMs\s*\/\s*1000/);
  assert.match(pipeline, /overlapBeforeMs:\s*0/);
  assert.match(pipeline, /overlapAfterMs:\s*0/);
  assert.doesNotMatch(r2SourceMedia + pipeline, /StreamMediaService|cloudflare\/stream|ContainerMediaProcessor|FFMPEG_CONTAINER/);
});

test('Phase 4A locks conservative deterministic stitch and rerun reconciliation thresholds', () => {
  assert.match(stitch, /1_500|1500/);
  assert.match(stitch, /750/);
  assert.match(stitch, /leftBest|rightBest/);
  assert.match(reconcile, /2_000|2000/);
  assert.match(reconcile, /existingSpeakerId/);
  assert.doesNotMatch(stitch + reconcile, /embedding|voiceprint|biometric/i);
});

test('Phase 4A reconciles speaker identity after ASR and before destructive replacement', () => {
  assertInOrder(pipeline, [
    'stitchInputs.push',
    'load existing speaker coverage',
    'stitchAsrChunks(stitchInputs)',
    'reconcileSpeakerIds(stitched',
    'replaceFromAsr(params.projectId, params.userId, normalized)',
  ]);
  assert.match(segmentStore, /ON CONFLICT\(id\) DO NOTHING/);
});

test('Phase 4A diarization adds no biometric or speaker-identity migration', () => {
  const migrations = readdirSync('migrations').filter((name) => name.endsWith('.sql'));
  assert.equal(migrations.some((name) => /speaker|diar|biometric|voiceprint/i.test(name)), false);
  const migrationSource = migrations.map((name) => read(`migrations/${name}`)).join('\n');
  assert.doesNotMatch(migrationSource, /voiceprint|speaker embedding|biometric template/i);
  assert.doesNotMatch(stitch + reconcile + segmentStore, /voiceprint|biometric template|speaker embedding/i);
});

test('Phase 4A remains source-qualified only', () => {
  assert.match(deploymentStatus, /Phase 4A/i);
  assert.match(deploymentStatus, /Production runtime remains \*\*UNQUALIFIED\*\*/i);
});
