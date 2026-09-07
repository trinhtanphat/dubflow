import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowSource = readFileSync(
  new URL('../src/workflows/ExportWorkflow.ts', import.meta.url),
  'utf8',
);

describe('zero-container production ExportWorkflow wiring', () => {
  it('constructs PCM soundtrack and Stream publishing dependencies without FFmpeg Container access', () => {
    expect(workflowSource).not.toMatch(/ContainerMediaProcessor|FFMPEG_CONTAINER|services\/media\/container/);
    expect(workflowSource).toMatch(/PcmSoundtrackService/);
    expect(workflowSource).toMatch(/StreamMediaService/);
    expect(workflowSource).toMatch(/soundtrack/);
    expect(workflowSource).toMatch(/publisher/);
    expect(workflowSource).toMatch(/stream:\s*this\.env\.STREAM/);
    expect(workflowSource).toMatch(/bucket:\s*this\.env\.MEDIA/);
    expect(workflowSource).toMatch(/publicOrigin:\s*this\.env\.PUBLIC_ORIGIN/);
    expect(workflowSource).toMatch(/signingSecret:\s*this\.env\.STREAM_SOURCE_SIGNING_SECRET/);
    expect(workflowSource).toMatch(/accountId:\s*this\.env\.CLOUDFLARE_ACCOUNT_ID/);
    expect(workflowSource).toMatch(/apiToken:\s*this\.env\.CLOUDFLARE_STREAM_API_TOKEN/);
  });
});
