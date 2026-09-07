import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildAtempoChain, buildRenderExportArgs, validateRenderExportInput } from '../containers/ffmpeg/render-export.mjs';

const dockerfile = readFileSync('containers/ffmpeg/Dockerfile', 'utf8');
const server = readFileSync('containers/ffmpeg/server.mjs', 'utf8');

const preserveInput = {
  projectId: 'project-1',
  objectKey: 'projects/project-1/source/source.mp4',
  targetLanguage: 'ja',
  exportId: 'exp-1',
  mixMode: 'preserve_background',
  backgroundObjectKey: 'projects/project-1/separation/2/demucs-container/sha256-8726e21a/background.wav',
  clips: [
    { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/voices/ja/s1/1.mp3' },
  ],
};

test('atempo chain supports duration fitting outside FFmpeg single-filter bounds', () => {
  assert.equal(buildAtempoChain(3000, 1500), 'atempo=2');
  assert.equal(buildAtempoChain(1000, 2000), 'atempo=0.5');
  assert.equal(buildAtempoChain(4000, 1000), 'atempo=2,atempo=2');
  assert.equal(buildAtempoChain(1000, 4000), 'atempo=0.5,atempo=0.5');
  assert.equal(buildAtempoChain(1500, 1500), '');
});

test('render graph fits downloaded voice duration to each segment window before delay', () => {
  const clips = [
    { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/dubbed/s1.mp3' },
    { segmentId: 's2', startMs: 3000, endMs: 5000, objectKey: 'projects/project-1/dubbed/s2.mp3' },
  ];
  const args = buildRenderExportArgs({
    sourcePath: '/tmp/source',
    outputPath: '/tmp/dubbed.mp4',
    durationMs: 6000,
    clips,
    clipPaths: ['/tmp/s1.mp3', '/tmp/s2.mp3'],
    clipDurationsMs: [3000, 1000],
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /atempo=2,atrim=duration=1\.5/);
  assert.match(graph, /atempo=0\.5,atrim=duration=2/);
  assert.match(graph, /adelay=1000\|1000/);
  assert.match(graph, /adelay=3000\|3000/);
});

test('preserve-background input accepts only a same-project canonical background stem', () => {
  assert.equal(validateRenderExportInput(structuredClone(preserveInput)).backgroundObjectKey, preserveInput.backgroundObjectKey);
  assert.throws(() => validateRenderExportInput({
    ...structuredClone(preserveInput),
    backgroundObjectKey: 'projects/other/separation/2/demucs-container/sha256-8726e21a/background.wav',
  }), /background|project/i);
  const { backgroundObjectKey: _missing, ...withoutBackground } = structuredClone(preserveInput);
  assert.throws(() => validateRenderExportInput(withoutBackground), /background/i);
  assert.throws(() => validateRenderExportInput({
    ...structuredClone(preserveInput),
    mixMode: 'dubbed_only',
  }), /background|mix/i);
});

test('preserve-background graph uses the downloaded background stem as base and never source audio', () => {
  const args = buildRenderExportArgs({
    sourcePath: '/tmp/source',
    outputPath: '/tmp/dubbed.mp4',
    durationMs: 6000,
    clips: preserveInput.clips,
    clipPaths: ['/tmp/s1.mp3'],
    clipDurationsMs: [1500],
    mixMode: 'preserve_background',
    backgroundPath: '/tmp/background.wav',
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.deepEqual(args.slice(0, 13), [
    '-nostdin', '-y', '-v', 'error', '-i', '/tmp/source', '-i', '/tmp/background.wav', '-i', '/tmp/s1.mp3', '-filter_complex', graph,
  ]);
  assert.match(graph, /^\[1:a\].*\[base\]/);
  assert.doesNotMatch(graph, /\[0:a\]/);
  assert.equal(args.includes('anullsrc=r=48000:cl=stereo'), false);
  const maps = args.flatMap((value, index) => value === '-map' ? [args[index + 1]] : []);
  assert.deepEqual(maps, ['0:v:0?', '[dubbed]']);
});

test('container image includes the render helper and probes every downloaded dubbed clip', () => {
  assert.match(dockerfile, /COPY\s+render-export\.mjs\s+\/app\/render-export\.mjs/);
  assert.match(server, /clipDurationsMs\.push\(await durationMs\(path\)\)/);
  assert.match(server, /buildRenderExportArgs\(\{[\s\S]*clipDurationsMs[\s\S]*\}\)/);
});

test('container downloads the preserve-background object separately from source and voices', () => {
  assert.match(server, /input\.mixMode\s*===\s*['"]preserve_background['"]/);
  assert.match(server, /downloadObject\(input\.backgroundObjectKey,\s*backgroundPath\)/);
  assert.match(server, /buildRenderExportArgs\(\{[\s\S]*mixMode:\s*input\.mixMode[\s\S]*backgroundPath[\s\S]*\}\)/);
});
