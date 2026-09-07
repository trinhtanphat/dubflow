import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowSource = await readFile(
  new URL('../worker/src/workflows/ExportWorkflow.ts', import.meta.url),
  'utf8',
);

test('production ExportWorkflow constructs PCM soundtrack and R2 remux publishing without Stream or FFmpeg Container access', () => {
  assert.doesNotMatch(workflowSource, /ContainerMediaProcessor|FFMPEG_CONTAINER|services\/media\/container/);
  assert.doesNotMatch(workflowSource, /StreamMediaService|services\/media\/stream|CLOUDFLARE_STREAM_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflowSource, /PcmSoundtrackService/);
  assert.match(workflowSource, /R2Mp4RemuxPublisher/);
  assert.match(workflowSource, /soundtrack/);
  assert.match(workflowSource, /publisher/);
  assert.match(workflowSource, /bucket:\s*this\.env\.MEDIA/);
});

test('subtitle-only production export does not construct the R2 remux publisher', () => {
  assert.match(workflowSource, /const\s+subtitleOnly\s*=\s*event\.payload\.output\s*===\s*'subtitles'/);
  assert.match(workflowSource, /subtitleOnly\s*\?\s*undefined\s*:\s*new\s+R2Mp4RemuxPublisher/);
  assert.doesNotMatch(workflowSource, /!this\.env\.STREAM/);
});
