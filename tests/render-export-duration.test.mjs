import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAtempoChain, buildRenderExportArgs } from '../containers/ffmpeg/render-export.mjs';

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
