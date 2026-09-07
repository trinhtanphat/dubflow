import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const longFormSource = readFileSync(
  new URL('../src/services/asr/r2-long-form.ts', import.meta.url),
  'utf8',
);
const productionPipelineSource = readFileSync(
  new URL('../src/workflows/pipeline.ts', import.meta.url),
  'utf8',
);

describe('R2 long-form Workers AI source feasibility', () => {
  it('uses encoded AAC packet demux/remux only and never relies on runtime audio decode/transcode', () => {
    expect(longFormSource).toMatch(/EncodedPacketSink/);
    expect(longFormSource).toMatch(/EncodedAudioPacketSource/);
    expect(longFormSource).toMatch(/Mp4OutputFormat/);
    expect(longFormSource).not.toMatch(/\bConversion\b|WavOutputFormat|forceTranscode|AudioDecoder|@mediabunny\/server/);
  });

  it('keeps the unqualified helper disconnected from the production pipeline', () => {
    expect(productionPipelineSource).not.toMatch(/r2-long-form/);
    expect(productionPipelineSource).not.toMatch(/extractR2LongFormAudioChunks/);
    expect(productionPipelineSource).toMatch(/ASR_LONG_FORM_UNAVAILABLE/);
  });
});
