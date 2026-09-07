import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowSource = await readFile(
  new URL('../worker/src/workflows/ExportWorkflow.ts', import.meta.url),
  'utf8',
);

test('production ExportWorkflow constructs PCM soundtrack and Stream publishing dependencies without FFmpeg Container access', () => {
  assert.doesNotMatch(workflowSource, /ContainerMediaProcessor|FFMPEG_CONTAINER|services\/media\/container/);
  assert.match(workflowSource, /PcmSoundtrackService/);
  assert.match(workflowSource, /StreamMediaService/);
  assert.match(workflowSource, /soundtrack/);
  assert.match(workflowSource, /publisher/);
  assert.match(workflowSource, /stream:\s*this\.env\.STREAM/);
  assert.match(workflowSource, /bucket:\s*this\.env\.MEDIA/);
  assert.match(workflowSource, /publicOrigin:\s*this\.env\.PUBLIC_ORIGIN/);
  assert.match(workflowSource, /signingSecret:\s*this\.env\.STREAM_SOURCE_SIGNING_SECRET/);
  assert.match(workflowSource, /accountId:\s*this\.env\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflowSource, /apiToken:\s*this\.env\.CLOUDFLARE_STREAM_API_TOKEN/);
});

test('subtitle-only production export does not require Stream publishing configuration', () => {
  assert.match(workflowSource, /const\s+subtitleOnly\s*=\s*event\.payload\.output\s*===\s*'subtitles'/);
  assert.match(workflowSource, /if\s*\(\s*!subtitleOnly\s*&&\s*!this\.env\.STREAM\s*\)/);
  assert.match(workflowSource, /subtitleOnly\s*\?\s*undefined\s*:\s*new\s+StreamMediaService/);
});
