import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildAtempoChain, buildRenderExportArgs } from '../containers/ffmpeg/render-export.mjs';

const dockerfile = readFileSync('containers/ffmpeg/Dockerfile', 'utf8');
const server = readFileSync('containers/ffmpeg/server.mjs', 'utf8');

const clips = [
  { segmentId: 's1', startMs: 1000, endMs: 1500, objectKey: 'projects/project-1/dubbed/s1.mp3' },
  { segmentId: 's2', startMs: 1550, endMs: 2000, objectKey: 'projects/project-1/dubbed/s2.mp3' },
];

function renderArgs(audioMode = 'dubbed_only', backgroundPath) {
  return buildRenderExportArgs({
    sourcePath: '/tmp/source',
    outputPath: '/tmp/dubbed.mp4',
    durationMs: 6000,
    clips,
    clipPaths: ['/tmp/s1.mp3', '/tmp/s2.mp3'],
    clipDurationsMs: [500, 450],
    audioMode,
    backgroundPath,
  });
}

function filterGraph(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

test('atempo chain supports duration fitting outside FFmpeg single-filter bounds', () => {
  assert.equal(buildAtempoChain(3000, 1500), 'atempo=2');
  assert.equal(buildAtempoChain(1000, 2000), 'atempo=0.5');
  assert.equal(buildAtempoChain(4000, 1000), 'atempo=2,atempo=2');
  assert.equal(buildAtempoChain(1000, 4000), 'atempo=0.5,atempo=0.5');
  assert.equal(buildAtempoChain(1500, 1500), '');
});

test('render graph fits downloaded voice duration to each segment window before delay', () => {
  const args = buildRenderExportArgs({
    sourcePath: '/tmp/source',
    outputPath: '/tmp/dubbed.mp4',
    durationMs: 6000,
    clips: [
      { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/dubbed/s1.mp3' },
      { segmentId: 's2', startMs: 3000, endMs: 5000, objectKey: 'projects/project-1/dubbed/s2.mp3' },
    ],
    clipPaths: ['/tmp/s1.mp3', '/tmp/s2.mp3'],
    clipDurationsMs: [3000, 1000],
  });
  const graph = filterGraph(args);
  assert.match(graph, /atempo=2,atrim=duration=1\.5/);
  assert.match(graph, /atempo=0\.5,atrim=duration=2/);
  assert.match(graph, /adelay=1000\|1000/);
  assert.match(graph, /adelay=3000\|3000/);
});

test('dubbed_only keeps the compatibility silent base and never mixes source audio', () => {
  const args = renderArgs('dubbed_only');
  const graph = filterGraph(args);
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  assert.match(graph, /\[1:a\]aresample=48000,asetpts=PTS-STARTPTS\[base\]/);
  assert.doesNotMatch(graph, /\[0:a\].*\[base\]/);
  assert.match(graph, /amix=inputs=3/);
});

test('duck_original uses source audio, merges speech windows, and attenuates exactly -18 dB with 80ms lead and 120ms tail', () => {
  const args = renderArgs('duck_original');
  const graph = filterGraph(args);
  assert.ok(!args.includes('anullsrc=r=48000:cl=stereo'));
  assert.match(graph, /\[0:a\]aresample=48000/);
  assert.match(graph, /volume=-18dB:enable='between\(t,0\.92,2\.12\)'/);
  assert.doesNotMatch(graph, /between\(t,0\.92,1\.62\).*between\(t,1\.47,2\.12\)/);
  assert.match(graph, /amix=inputs=3/);
});

test('separated_background uses only the staged background bed plus dubbed clips', () => {
  const args = renderArgs('separated_background', '/tmp/background.wav');
  const graph = filterGraph(args);
  assert.ok(args.includes('/tmp/background.wav'));
  assert.ok(!args.includes('anullsrc=r=48000:cl=stereo'));
  assert.match(graph, /\[1:a\]aresample=48000,asetpts=PTS-STARTPTS\[base\]/);
  assert.doesNotMatch(graph, /\[0:a\].*\[base\]/);
  assert.match(graph, /amix=inputs=3/);
});

test('container image includes the render helper and probes every downloaded dubbed clip', () => {
  assert.match(dockerfile, /COPY\s+render-export\.mjs\s+\/app\/render-export\.mjs/);
  assert.match(server, /clipDurationsMs\.push\(await durationMs\(path\)\)/);
  assert.match(server, /buildRenderExportArgs\(\{[\s\S]*clipDurationsMs[\s\S]*\}\)/);
});
