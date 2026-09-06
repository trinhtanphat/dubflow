import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

const wrangler = read('wrangler.jsonc');
const sharesMigration = read('migrations/0006_export_shares.sql');
const sharesRouteSource = read('worker/src/routes/shares.ts');
const telemetrySource = read('worker/src/observability/telemetry.ts');
const requestTelemetrySource = read('worker/src/observability/requestTelemetry.ts');
const rateLimitSource = read('worker/src/security/rate-limit.ts');
const processRouteSource = read('worker/src/routes/process.ts');
const exportRouteSource = read('worker/src/routes/export.ts');
const uploadRouteSource = read('worker/src/routes/uploads.ts');
const translationRouteSource = read('worker/src/routes/translation.ts');
const voiceRouteSource = read('worker/src/routes/voice.ts');
const mediaStreamSource = read('worker/src/http/media-stream.ts');
const shareTokenSource = read('worker/src/security/share-token.ts');
const shareStoreSource = read('worker/src/db/shares.ts');
const shareApiSource = read('src/features/sharing/shareApi.ts');
const sharePanelSource = read('src/features/sharing/SharePanel.tsx');
const studioShellSource = [read('src/app/StudioShell.tsx'), read('src/app/StudioShellBase.tsx')].join('\n');
const deploymentStatus = read('docs/deployment-status.md');

function assertInOrder(source, labels) {
  let previous = -1;
  for (const label of labels) {
    const index = source.indexOf(label);
    assert.notEqual(index, -1, `missing ordered source marker: ${label}`);
    assert.ok(index > previous, `source marker is out of order: ${label}`);
    previous = index;
  }
}

function typeBlock(source, declaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `type declaration must remain identifiable: ${declaration}`);
  return source.slice(start, end + 3);
}

test('Phase 3C safety gate pins observability and five isolated Cloudflare limiter namespaces', () => {
  assert.match(wrangler, /"analytics_engine_datasets"/);
  assert.match(wrangler, /"dataset"\s*:\s*"dubflow_events"/);
  assert.match(wrangler, /"redact_query_string"\s*:\s*true/);
  assert.match(wrangler, /"traces"[\s\S]*?"head_sampling_rate"\s*:\s*0\.05/);

  for (const name of [
    'RATE_LIMIT_PROCESS',
    'RATE_LIMIT_EXPORT',
    'RATE_LIMIT_TRANSLATE',
    'RATE_LIMIT_VOICE',
    'RATE_LIMIT_UPLOAD',
  ]) {
    assert.match(wrangler, new RegExp(`"name"\\s*:\\s*"${name}"`));
  }

  const namespaceIds = [...wrangler.matchAll(/"namespace_id"\s*:\s*"(\d+)"/g)].map((match) => match[1]);
  assert.ok(namespaceIds.length >= 5, 'Phase 3C five limiter namespaces must remain present');
  assert.equal(new Set(namespaceIds).size, namespaceIds.length, 'every configured limiter namespace must remain isolated');
});

test('Phase 3C safety gate keeps share secrets one-way and owner listings non-secret', () => {
  assert.match(sharesMigration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sharesRouteSource, /\/shares\/:shareId\/media/);
  assert.match(sharesRouteSource, /query\(['"]token['"]\)/);
  assert.match(sharesRouteSource, /Referrer-Policy['"],?\s*['"]no-referrer/);

  const listStart = sharesRouteSource.indexOf("routes.get('/:id/shares'");
  const listEnd = sharesRouteSource.indexOf("routes.delete('/:id/shares/:shareId'", listStart);
  assert.ok(listStart >= 0 && listEnd > listStart, 'owner share list route must remain identifiable');
  const shareListRouteSource = sharesRouteSource.slice(listStart, listEnd);
  assert.doesNotMatch(shareListRouteSource, /token_hash[^\n]*json|tokenHash[^\n]*return/);
  assert.doesNotMatch(shareListRouteSource, /shareUrl|rawToken/);
});

test('Phase 3C safety gate keeps telemetry bounded and outside billing state', () => {
  const eventTypeStart = telemetrySource.indexOf('export type TelemetryEvent = {');
  const eventTypeEnd = telemetrySource.indexOf('\n};', eventTypeStart);
  assert.ok(eventTypeStart >= 0 && eventTypeEnd > eventTypeStart, 'TelemetryEvent schema must remain identifiable');
  const eventSchema = telemetrySource.slice(eventTypeStart, eventTypeEnd);

  assert.doesNotMatch(
    eventSchema,
    /sourceText|translatedText|rawToken|tokenHash|requestBody|responseBody|queryString|rawUrl|apiKey|secret|mediaContent/i,
  );

  for (const source of [telemetrySource, requestTelemetrySource, rateLimitSource]) {
    assert.doesNotMatch(source, /usage_events|credit_balance/i);
    assert.doesNotMatch(source, /UPDATE\s+users|INSERT\s+INTO\s+usage_events/i);
  }
});

test('Phase 3C safety gate locks validation-before-limit and limiter-before-expensive-side-effect ordering', () => {
  assert.match(rateLimitSource, /key: `\$\{actor\}:\$\{operation\}`/);
  assert.match(rateLimitSource, /Retry-After/);
  assert.match(rateLimitSource, /RATE_LIMITED/);
  assert.doesNotMatch(rateLimitSource, /usage_events|credit_balance|cost_basis|price/i);

  assertInOrder(processRouteSource, [
    'getByIdForUser(projectId, userId)',
    'project.sourceObjectKey',
    "enforceRateLimit(c, 'process'",
    "jobs.create(projectId, 'dubbing')",
    'DUBBING_WORKFLOW.create',
  ]);

  const exportValidationStart = exportRouteSource.indexOf('async function validateTarget(');
  const exportLaunchStart = exportRouteSource.indexOf('async function launchValidated(', exportValidationStart);
  const exportStartSingle = exportRouteSource.indexOf('async function startSingle(', exportLaunchStart);
  const exportBatchRoute = exportRouteSource.indexOf("routes.post('/:id/exports/batch'", exportStartSingle);
  assert.ok(
    exportValidationStart >= 0 && exportLaunchStart > exportValidationStart
      && exportStartSingle > exportLaunchStart && exportBatchRoute > exportStartSingle,
    'export validation, launch, and single-start boundaries must remain identifiable',
  );
  const exportValidationSource = exportRouteSource.slice(exportValidationStart, exportLaunchStart);
  const exportLaunchSource = exportRouteSource.slice(exportLaunchStart, exportStartSingle);
  const exportSingleSource = exportRouteSource.slice(exportStartSingle, exportBatchRoute);

  assertInOrder(exportValidationSource, [
    'getByIdForUser(projectId, userId)',
    'project.sourceObjectKey',
    "['needs_review', 'completed']",
    'makeLanguages(env).getConfig(projectId, userId)',
    'translationsComplete(sourceSegments, variants)',
    'voiceTargetError(getVoiceCapabilities(env), targetLanguage)',
  ]);
  assertInOrder(exportSingleSource, [
    'validateTarget(c.env, projectId, userId, targetLanguage, output)',
    "enforceRateLimit(c, 'export'",
    'launchValidated(',
  ]);
  assertInOrder(exportLaunchSource, [
    'exportsStore.create(projectId, userId, targetLanguage, output, batchId, audioMode)',
    'jobs.create(projectId, legacy ? \'export\'',
    "setStatus(projectId, userId, 'processing')",
    'EXPORT_WORKFLOW.create',
  ]);

  assertInOrder(uploadRouteSource, [
    'validateBegin(projectId, userId, await c.req.json())',
    "enforceRateLimit(c, 'upload'",
    'beginValidated(projectId, input)',
  ]);
  const multipartContinuation = uploadRouteSource.slice(uploadRouteSource.indexOf("routes.put('/:id/uploads/:uploadId/parts/:partNumber'"));
  assert.doesNotMatch(multipartContinuation, /enforceRateLimit/);

  assertInOrder(translationRouteSource, [
    'getByIdForUser(projectId, userId)',
    'segments.get(projectId, segmentId, userId)',
    'const expectedVersion = input.expectedVersion',
    'MODES.has(input.mode)',
    'segment.version !== expectedVersion',
    "enforceRateLimit(c, 'translate'",
    'makeRouter(c.env).translate(',
  ]);
  assertInOrder(voiceRouteSource, [
    'payload = await c.req.json()',
    'if (!text)',
    'text.length > 2000',
    "language !== 'vi'",
    '!hasElevenLabsPreview(c.env)',
    "enforceRateLimit(c, 'voice'",
    'provider.generate(',
  ]);
});

test('Phase 3C safety gate locks 256-bit hash-only bearer shares and one Range implementation', () => {
  assert.match(shareTokenSource, /new Uint8Array\(32\)/);
  assert.match(shareTokenSource, /crypto\.getRandomValues/);
  assert.match(shareTokenSource, /SHA-256/);
  assert.doesNotMatch(sharesMigration, /\btoken\s+TEXT\b/i);
  assert.doesNotMatch(typeBlock(shareStoreSource, 'export type ExportShare = {'), /tokenHash|token_hash|shareUrl/);

  assert.match(mediaStreamSource, /status: 416/);
  assert.match(mediaStreamSource, /status: parsedRange \? 206 : 200/);
  assert.match(mediaStreamSource, /Accept-Ranges/);
  assert.match(mediaStreamSource, /Content-Range/);
  assert.match(exportRouteSource, /streamMediaObject\(/);
  assert.match(sharesRouteSource, /streamMediaObject\(/);
});

test('Phase 3C safety gate locks one-time Studio bearer-link semantics', () => {
  assert.doesNotMatch(typeBlock(shareApiSource, 'export type ExportShare = {'), /shareUrl|tokenHash|token_hash/);
  assert.match(typeBlock(shareApiSource, 'export type CreateShareResult = {'), /shareUrl: string/);
  assert.match(sharePanelSource, /const \[createdShareUrl, setCreatedShareUrl\] = useState\(''\)/);
  assert.match(sharePanelSource, /setCreatedShareUrl\(result\.shareUrl\)/);
  assert.match(sharePanelSource, /listShares\(projectId\)/);
  assert.match(sharePanelSource, /Mã cuối: \{share\.tokenHint\}/);
  assert.doesNotMatch(sharePanelSource, /tokenHint[^\n]*(?:shareUrl|\/api\/shares)/);
  assert.match(studioShellSource, /shareOpen && state\.project\.exportObjectKey/);
  assert.match(studioShellSource, /<SharePanel projectId=\{state\.project\.id\}/);
});

test('Phase 3C safety gate requires source-only qualification docs without upgrading runtime status', () => {
  assert.match(deploymentStatus, /## Phase 3C .*qualification/i);
  for (const name of [
    'RATE_LIMIT_PROCESS',
    'RATE_LIMIT_EXPORT',
    'RATE_LIMIT_TRANSLATE',
    'RATE_LIMIT_VOICE',
    'RATE_LIMIT_UPLOAD',
  ]) assert.match(deploymentStatus, new RegExp(name));
  assert.match(deploymentStatus, /dubflow_events/);
  assert.match(deploymentStatus, /revocable/i);
  assert.match(deploymentStatus, /SHARE_NOT_FOUND/);
  assert.match(deploymentStatus, /manual-only/i);
  assert.match(deploymentStatus, /runtime (?:status )?remains \*\*UNQUALIFIED\*\*/i);
});
