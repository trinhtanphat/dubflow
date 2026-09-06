import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildAtempoChain, buildRenderExportArgs, validateRenderExportInput } from '../containers/ffmpeg/render-export.mjs';

const dockerfile = readFileSync('containers/ffmpeg/Dockerfile', 'utf8');
const server = readFileSync('containers/ffmpeg/server.mjs', 'utf8');

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

test('preserved-background render accepts only canonical project stem and keeps source video', () => {
  const input = {
    projectId: 'project-1',
    objectKey: 'projects/project-1/source/source_rev.mp4',
    targetLanguage: 'vi',
    exportId: 'export-1',
    backgroundObjectKey: 'projects/project-1/stems/source_rev/background.wav',
    clips: [
      { segmentId: 's1', startMs: 1000, endMs: 2500, objectKey: 'projects/project-1/voices/vi/s1/1.mp3' },
    ],
  };
  assert.deepEqual(validateRenderExportInput(input), input);
  assert.throws(() => validateRenderExportInput({
    ...input,
    backgroundObjectKey: 'projects/other/stems/source_rev/background.wav',
  }), /background|project/i);

  const args = buildRenderExportArgs({
    sourcePath: '/tmp/source',
    backgroundPath: '/tmp/background.wav',
    outputPath: '/tmp/dubbed.mp4',
    durationMs: 6000,
    clips: input.clips,
    clipPaths: ['/tmp/s1.mp3'],
    clipDurationsMs: [1500],
  });
  assert.ok(args.includes('/tmp/background.wav'));
  assert.ok(!args.includes('anullsrc=r=48000:cl=stereo'));
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[1:a\]aresample=48000/);
  assert.match(graph, /\[2:a\]aresample=48000/);
  const mapIndex = args.indexOf('-map');
  assert.equal(args[mapIndex + 1], '0:v:0?');
});

test('container image includes the render helper and probes every downloaded dubbed clip', () => {
  assert.match(dockerfile, /COPY\s+render-export\.mjs\s+\/app\/render-export\.mjs/);
  assert.match(server, /clipDurationsMs\.push\(await durationMs\(path\)\)/);
  assert.match(server, /buildRenderExportArgs\(\{[\s\S]*clipDurationsMs[\s\S]*\}\)/);
});

test('container downloads the optional background stem before building render arguments', () => {
  assert.match(server, /backgroundObjectKey/);
  assert.match(server, /downloadObject\(input\.backgroundObjectKey,[\s\S]*background/);
  assert.match(server, /buildRenderExportArgs\(\{[\s\S]*backgroundPath/);
});
