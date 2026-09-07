import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scriptUrl = new URL('../scripts/verify-production-browser-piper-fixture.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/production-browser-piper-fixture.yml', import.meta.url);

test('browser-driven production Piper fixture is checked in and manual-only', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing browser Piper production fixture runner');
  assert.equal(fs.existsSync(workflowUrl), true, 'missing browser Piper production fixture workflow');

  const script = fs.readFileSync(scriptUrl, 'utf8');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(script, /yupvox\.qs3d\.site/);
  assert.match(script, /remote-debugging-port/);
  assert.match(script, /data-testid=["']export-current-language["']/);
  assert.match(script, /\/translations\/vi/);
  assert.match(script, /voiceStatus/);
  assert.match(script, /dubbedObjectKey/);
  assert.match(script, /\/exports\/vi/);
  assert.match(script, /workers-ai-whisper-large-v3-turbo/);

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /CHROME_BIN/);
  assert.match(workflow, /verify-production-browser-piper-fixture\.mjs/);
  assert.match(workflow, /ffprobe/);
  assert.match(workflow, /codec_name/);
  assert.match(workflow, /h264/);
  assert.match(workflow, /aac/);
  assert.match(workflow, /sha256sum/);

  const combined = `${script}\n${workflow}`;
  assert.doesNotMatch(combined, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
  assert.doesNotMatch(combined, /PAID_[A-Z0-9_]+\s*=\s*true/i);
  assert.doesNotMatch(combined, /CLOUDFLARE_STREAM|FFMPEG_CONTAINER/);
});

test('browser fixture source admission proves zero-cost provider routing before live media calls', async () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing browser Piper production fixture runner');
  const script = fs.readFileSync(scriptUrl, 'utf8');

  assert.match(script, /assertCheckedOutZeroCostSource/);
  assert.match(script, /services\/asr\/router\.ts/);
  assert.match(script, /services\/translation\/router\.ts/);
  assert.match(script, /zeroContainerExportPipeline\.ts/);
  assert.match(script, /PAID_DEEPGRAM_ASR_ENABLED/);
  assert.match(script, /requested\s*===\s*undefined/);
  assert.match(script, /targetVoiceObjectKey/);
  assert.match(script, /deps\.voice\.generate/);

  const runner = await import(scriptUrl.href);
  assert.doesNotThrow(() => runner.assertCheckedOutZeroCostSource());
});

test('browser fixture preserves CHROME_BIN discovered through GITHUB_ENV', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /echo\s+["']CHROME_BIN=\$CHROME["']\s*>>\s*["']\$GITHUB_ENV["']/);
  assert.doesNotMatch(workflow, /CHROME_BIN:\s*\$\{\{\s*env\.CHROME_BIN\s*\}\}/);
});

test('browser fixture independently verifies exact-version client PCM before accepting export launch', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing browser Piper production fixture runner');
  const script = fs.readFileSync(scriptUrl, 'utf8');

  assert.match(script, /projects\/\$\{projectId\}\/voices\/vi\/\$\{segmentId\}\/\$\{version\}\.pcm/);
  assert.match(script, /translationStatus/);
  assert.match(script, /voiceStatus/);
  assert.match(script, /dubbedObjectKey/);
  assert.match(script, /Unable to verify exact Vietnamese browser PCM cache/);
});

test('browser fixture fails closed on a production UI error before final export qualification', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing browser Piper production fixture runner');
  const script = fs.readFileSync(scriptUrl, 'utf8');

  assert.match(script, /batch-export__error/);
  assert.match(script, /Export current language/);
  assert.match(script, /Browser Piper export did not launch/);
  assert.doesNotMatch(script, /startLanguageExport|\/api\/projects\/[^\n]*\/exports\/vi[^\n]*method:\s*['"]POST/);
});
