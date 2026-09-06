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
  assert.equal(namespaceIds.length, 5);
  assert.equal(new Set(namespaceIds).size, 5);
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
