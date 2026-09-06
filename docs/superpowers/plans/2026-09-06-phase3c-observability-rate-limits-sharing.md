# DubFlow Phase 3C Observability, Rate Limits, and Revocable Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cloudflare-native observability and expensive-operation rate limiting, plus revocable anonymous read-only export sharing with hash-only token persistence and shared byte-range streaming.

**Architecture:** Workers Logs/Traces provide request diagnostics, Workers Analytics Engine records normalized high-cardinality operational events, and Workers Rate Limiting bindings provide permissive abuse control before expensive work. Export sharing uses 256-bit one-time secrets whose SHA-256 hashes are stored in D1; owner and anonymous share downloads converge on one R2 Range streaming helper so 200/206/416 behavior cannot drift.

**Tech Stack:** TypeScript 5.8, Hono 4.9, Cloudflare Workers/Workflows, Workers Rate Limiting bindings, Workers Analytics Engine, D1, R2, React 19, Vitest 3, Wrangler 4.45.

**Spec:** `docs/superpowers/specs/2026-09-06-phase3c-observability-rate-limits-sharing-design.md`

## Global Constraints

- Implementation base is live `main` `caee266d01c8dc8194e9d3abf57dc6908dfd92c6`; re-check before merge and reconcile non-force if `main` advances.
- Phase 3B `usage_events` remains the accounting source of truth; telemetry must not replace it.
- Rate limiting is abuse/admission control only and must never become exact billing, credit, or quota enforcement.
- Initial limits are `process=4/min`, `export=4/min`, `translate=30/min`, `voice=30/min`, `upload=20/min` with 60-second periods.
- Project/resource authorization and request validation happen before consuming a rate-limit token; limiter rejection happens before jobs, workflows, R2 multipart creation, or provider calls.
- `429` responses use code `RATE_LIMITED` and `Retry-After: 60` and must not write usage events, mutate credits, or change project state.
- Analytics Engine dataset is `dubflow_events`; telemetry event names are `request_completed`, `provider_success`, `provider_failure`, `rate_limited`, `share_access`, `export_download`.
- Telemetry never contains transcript/source/translated/voice text, API keys, auth/cookie headers, provider response bodies, raw share secrets, token hashes, or raw query strings.
- Workers logs sample at `1.0`; traces sample at `0.05`; query strings are redacted from logs/traces.
- Share secrets are 256-bit CSPRNG values. D1 stores SHA-256 only. Plaintext is returned once at creation and never persisted.
- Share default expiry is 7 days; accepted TTL is 3600 through 2592000 seconds. Unknown/expired/revoked shares all return the same `404 SHARE_NOT_FOUND` shape.
- Public shared media contract is `GET /api/shares/:shareId/media?token=<secret>`; `shareId` is non-secret and the query string is platform-redacted.
- Existing owner download remains owner-authorized and media playback/download is not counted as an expensive AI rate-limit operation.
- Phase 3C does not add collaborators, permissions matrices, public discovery, billing/payment UI, exact quotas, or a new regenerate-voice feature.
- No production deploy is qualified until the separate Cloudflare Container credential and live provider/media fixture gates are satisfied.

---

### Task 1: Platform observability bindings, telemetry contract, and request correlation

**Files:**
- Create: `worker/src/observability/telemetry.ts`
- Create: `worker/src/observability/requestTelemetry.ts`
- Create: `worker/test/telemetry.test.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/app.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces `AnalyticsEngineDatasetLike.writeDataPoint(point): void`.
- Produces `TelemetrySink.write(event: TelemetryEvent): void`.
- Produces `createTelemetry(env: Pick<Env, 'ANALYTICS'>): TelemetrySink`.
- Produces `emitTelemetry(sink, event): void`, which swallows telemetry failures after a sanitized `console.error('telemetry_write_failed')` marker.
- Produces `withProviderTelemetry(sink, context, fn)` for later route/workflow provider instrumentation.
- Produces request middleware that creates one server `requestId`, stores it in Hono context, returns `x-request-id`, and emits one `request_completed` event with a normalized route template.

- [ ] **Step 1: Write failing telemetry tests**

Add tests that use a fake Analytics Engine binding and assert ordered, normalized datapoints rather than arbitrary objects:

```ts
const points: unknown[] = [];
const env = {
  ANALYTICS: { writeDataPoint(point: unknown) { points.push(point); } },
};
const sink = createTelemetry(env as never);
emitTelemetry(sink, {
  name: 'rate_limited',
  requestId: 'req-1',
  actorId: 'user-1',
  projectId: 'p1',
  operation: 'process',
  status: 'rejected',
  httpStatus: 429,
  durationMs: 12,
});
expect(JSON.stringify(points[0])).not.toContain('transcript');
expect(JSON.stringify(points[0])).not.toContain('token=');
```

Add a provider wrapper test that throws `new Error('secret upstream body')` and asserts the emitted failure contains only the supplied normalized code, never the raw message.

Add a middleware test using a small Hono app that asserts:

```ts
expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
expect(events).toContainEqual(expect.objectContaining({
  name: 'request_completed',
  method: 'GET',
  httpStatus: 200,
}));
```

Run: `npx vitest run worker/test/telemetry.test.ts`
Expected: FAIL because observability modules and bindings do not exist.

- [ ] **Step 2: Add Cloudflare binding types to `Env`**

Add minimal runtime-compatible interfaces rather than importing generated Wrangler types:

```ts
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface Env {
  // existing bindings...
  ANALYTICS: AnalyticsEngineDatasetLike;
}
```

- [ ] **Step 3: Implement normalized telemetry encoding**

Use a fixed Analytics Engine schema so blob/double positions never change between event kinds. Keep a single index derived from opaque actor ID when available, otherwise `anonymous`:

```ts
export type TelemetryEventName =
  | 'request_completed'
  | 'provider_success'
  | 'provider_failure'
  | 'rate_limited'
  | 'share_access'
  | 'export_download';

export type TelemetryEvent = {
  name: TelemetryEventName;
  requestId?: string;
  actorId?: string;
  projectId?: string;
  jobId?: string;
  shareId?: string;
  operation?: string;
  provider?: string;
  status?: string;
  errorCode?: string;
  method?: string;
  route?: string;
  accessMode?: 'owner' | 'share';
  rangeRequest?: boolean;
  httpStatus?: number;
  durationMs?: number;
};
```

Encode blobs in documented fixed order and numeric fields as `[httpStatus ?? 0, durationMs ?? 0, rangeRequest ? 1 : 0]`. Do not accept arbitrary metadata bags.

`withProviderTelemetry` records `provider_success` or `provider_failure` and rethrows the original business error:

```ts
export async function withProviderTelemetry<T>(
  sink: TelemetrySink,
  context: Omit<TelemetryEvent, 'name' | 'status' | 'durationMs'> & { errorCode: string },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    emitTelemetry(sink, { ...context, name: 'provider_success', status: 'success', errorCode: undefined, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    emitTelemetry(sink, { ...context, name: 'provider_failure', status: 'failure', durationMs: Date.now() - started });
    throw error;
  }
}
```

- [ ] **Step 4: Add request correlation middleware**

Define the shared Hono environment:

```ts
export type WorkerHonoEnv = {
  Bindings: Env;
  Variables: { requestId: string };
};
```

Middleware behavior:

```ts
export function requestTelemetryMiddleware(makeSink = createTelemetry) {
  return async (c: Context<WorkerHonoEnv>, next: Next) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
    emitTelemetry(makeSink(c.env), {
      name: 'request_completed',
      requestId,
      actorId: getCurrentUserId(),
      method: c.req.method,
      route: normalizedRoute(c),
      httpStatus: c.res.status,
      durationMs: Date.now() - started,
      status: c.res.status < 500 ? 'completed' : 'failed',
    });
  };
}
```

`normalizedRoute(c)` must return a route template/operation identifier from matched Hono routing information or a hand-maintained safe template map; it must never copy `c.req.url` or a query string.

Mount with `app.use('/api/*', requestTelemetryMiddleware())` before API routes.

- [ ] **Step 5: Configure Analytics Engine and observability explicitly**

Update `wrangler.jsonc` with:

```jsonc
"analytics_engine_datasets": [
  { "binding": "ANALYTICS", "dataset": "dubflow_events" }
],
"observability": {
  "enabled": true,
  "head_sampling_rate": 1,
  "logs": { "enabled": true, "head_sampling_rate": 1 },
  "traces": { "enabled": true, "head_sampling_rate": 0.05 },
  "redact_query_string": true
}
```

If Wrangler rejects a redundant top-level `head_sampling_rate`, remove only the redundant field while preserving logs `1.0`, traces `0.05`, and query redaction.

- [ ] **Step 6: Run Task 1 tests and config validation**

Run:
- `npx vitest run worker/test/telemetry.test.ts`
- `npx wrangler deploy --dry-run`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add worker/src/observability worker/test/telemetry.test.ts worker/src/env.ts worker/src/app.ts wrangler.jsonc
git commit -m "feat: add Phase 3C observability foundation"
```

---

### Task 2: Cloudflare Rate Limiting bindings and deterministic admission helper

**Files:**
- Create: `worker/src/security/rate-limit.ts`
- Create: `worker/test/rate-limit.test.ts`
- Modify: `worker/src/env.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces `RateLimitOperation = 'process' | 'export' | 'translate' | 'voice' | 'upload'`.
- Produces `RateLimitBindingLike.limit({ key }): Promise<{ success: boolean }>`.
- Produces `checkRateLimit(env, operation, userId): Promise<{ allowed: boolean; retryAfterSeconds: 60 }>`.
- Produces `rateLimitResponse(c, operation)` returning `429 RATE_LIMITED` with `Retry-After: 60`.

- [ ] **Step 1: Write failing helper tests**

Test exact binding selection and user/action key construction:

```ts
await checkRateLimit(env, 'process', 'user-a');
expect(processKeys).toEqual(['user-a:process']);
expect(exportKeys).toEqual([]);

await checkRateLimit(env, 'export', 'user-a');
expect(exportKeys).toEqual(['user-a:export']);
```

Also assert a failed binding returns `{ allowed: false, retryAfterSeconds: 60 }` and that empty user IDs are rejected before calling a binding.

Run: `npx vitest run worker/test/rate-limit.test.ts`
Expected: FAIL because helper/bindings do not exist.

- [ ] **Step 2: Add rate-limit binding types and five Env bindings**

```ts
export interface RateLimitBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  RATE_LIMIT_PROCESS: RateLimitBindingLike;
  RATE_LIMIT_EXPORT: RateLimitBindingLike;
  RATE_LIMIT_TRANSLATE: RateLimitBindingLike;
  RATE_LIMIT_VOICE: RateLimitBindingLike;
  RATE_LIMIT_UPLOAD: RateLimitBindingLike;
}
```

- [ ] **Step 3: Implement one binding selector and helper**

```ts
const bindingName = {
  process: 'RATE_LIMIT_PROCESS',
  export: 'RATE_LIMIT_EXPORT',
  translate: 'RATE_LIMIT_TRANSLATE',
  voice: 'RATE_LIMIT_VOICE',
  upload: 'RATE_LIMIT_UPLOAD',
} as const;

export async function checkRateLimit(env: Env, operation: RateLimitOperation, userId: string) {
  const actor = userId.trim();
  if (!actor) throw new Error('Rate-limit actor is required.');
  const { success } = await env[bindingName[operation]].limit({ key: `${actor}:${operation}` });
  return { allowed: success, retryAfterSeconds: 60 as const };
}
```

- [ ] **Step 4: Add five distinct Wrangler namespaces**

Use one DubFlow-only contiguous namespace range and assert uniqueness in acceptance tests later. Configure exactly:

```jsonc
"ratelimits": [
  { "name": "RATE_LIMIT_PROCESS",   "namespace_id": "31001", "simple": { "limit": 4,  "period": 60 } },
  { "name": "RATE_LIMIT_EXPORT",    "namespace_id": "31002", "simple": { "limit": 4,  "period": 60 } },
  { "name": "RATE_LIMIT_TRANSLATE", "namespace_id": "31003", "simple": { "limit": 30, "period": 60 } },
  { "name": "RATE_LIMIT_VOICE",     "namespace_id": "31004", "simple": { "limit": 30, "period": 60 } },
  { "name": "RATE_LIMIT_UPLOAD",    "namespace_id": "31005", "simple": { "limit": 20, "period": 60 } }
]
```

- [ ] **Step 5: Run Task 2 tests and dry-run**

Run:
- `npx vitest run worker/test/rate-limit.test.ts`
- `npx wrangler deploy --dry-run`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add worker/src/security/rate-limit.ts worker/test/rate-limit.test.ts worker/src/env.ts wrangler.jsonc
git commit -m "feat: add expensive operation rate limits"
```

---

### Task 3: Enforce rate limits at route admission boundaries

**Files:**
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/routes/uploads.ts`
- Modify: `worker/src/routes/translation.ts`
- Modify: `worker/src/routes/voice.ts`
- Modify: `worker/src/services/uploads.ts`
- Modify: corresponding existing route/service tests
- Create if cleaner: `worker/test/rate-limited-routes.test.ts`

**Interfaces:**
- Consumes `checkRateLimit`, request `requestId`, `createTelemetry`, `emitTelemetry`.
- Produces no new public API except `429 RATE_LIMITED` behavior.
- Upload service produces a validation seam so route code can validate authorization/input before consuming the limiter and before R2 multipart creation.

- [ ] **Step 1: Write route RED tests for project-scoped operations**

For `process` and `export`, inject a rejecting limiter and spies for jobs/workflows. Assert:

```ts
expect(response.status).toBe(429);
expect(response.headers.get('Retry-After')).toBe('60');
expect(await response.json()).toEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
expect(jobCreate).not.toHaveBeenCalled();
expect(workflowCreate).not.toHaveBeenCalled();
```

Add an unauthorized project case that returns 404 and asserts the limiter spy was not called.

For upload begin, assert invalid media input and unauthorized project do not consume limiter budget, while a valid authorized begin rejected by the limiter never calls `createMultipartUpload`.

Run the focused existing route tests plus the new file. Expected: FAIL because routes do not call the limiter.

- [ ] **Step 2: Split upload begin validation from multipart creation**

Refactor only the begin path:

```ts
async validateBegin(projectId: string, userId: string, rawInput: BeginUploadInput) {
  await this.requireProject(projectId, userId);
  return normalizeUploadInput(rawInput);
}

async beginValidated(projectId: string, input: NormalizedUploadInput) {
  const objectKey = `projects/${projectId}/source/${this.createId()}.${input.extension}`;
  const multipart = await this.bucket.createMultipartUpload(objectKey);
  return { uploadId: multipart.uploadId, objectKey, partSizeBytes: MULTIPART_PART_SIZE_BYTES };
}
```

Keep `begin()` as a compatibility wrapper for existing tests/callers:

```ts
async begin(projectId: string, userId: string, rawInput: BeginUploadInput) {
  return this.beginValidated(projectId, await this.validateBegin(projectId, userId, rawInput));
}
```

- [ ] **Step 3: Add a shared route admission helper**

In `rate-limit.ts`, add:

```ts
export async function enforceRateLimit(
  c: Context<WorkerHonoEnv>,
  operation: RateLimitOperation,
  userId: string,
  telemetry: TelemetrySink,
  projectId?: string,
): Promise<Response | null> {
  const decision = await checkRateLimit(c.env, operation, userId);
  if (decision.allowed) return null;
  emitTelemetry(telemetry, {
    name: 'rate_limited',
    requestId: c.get('requestId'),
    actorId: userId,
    projectId,
    operation,
    status: 'rejected',
    httpStatus: 429,
  });
  c.header('Retry-After', '60');
  return c.json(errorBody('RATE_LIMITED', `Too many ${operation} requests.`), 429);
}
```

- [ ] **Step 4: Apply ordering to process/export/upload**

`process`: authorize project -> require source -> enforce `process` -> `jobs.create()` -> Workflow create.

`export`: authorize project -> require source/exportable/voice config -> enforce `export` -> `jobs.create()` -> set processing -> Workflow create.

`upload`: parse JSON -> `validateBegin` -> enforce `upload` -> `beginValidated`.

Do not rate-limit part uploads or multipart completion.

- [ ] **Step 5: Write and run interactive-AI RED tests**

For segment retranslation, assert invalid version/mode and cross-user segment return before limiter; a valid request rejected by limiter does not call translation providers.

For voice preview, assert invalid JSON/text/language/provider configuration return before limiter; a valid configured request rejected by limiter does not call ElevenLabs.

- [ ] **Step 6: Apply `translate` and `voice` rate limits**

`translation`: ownership -> segment -> request/version/mode validation -> enforce -> provider router.

`voice`: JSON/text/language/provider-config validation -> enforce -> ElevenLabs generate.

The current preview route is the only live `voice` operation. Do not invent regenerate-voice.

- [ ] **Step 7: Run all route admission tests**

Run:
- `npx vitest run worker/test`

Expected: all Worker tests PASS, including assertions that rejected requests create no jobs/provider/R2 work and emit `rate_limited` only after authorization/validation.

- [ ] **Step 8: Commit Task 3**

```bash
git add worker/src/routes worker/src/services/uploads.ts worker/test
git commit -m "feat: enforce expensive route admission limits"
```

---

### Task 4: Provider success/failure telemetry across direct routes and durable workflows

**Files:**
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/routes/translation.ts`
- Modify: `worker/src/routes/voice.ts`
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`
- Modify: `worker/test/export-pipeline.test.ts`
- Add focused provider telemetry tests where existing fixtures would become unwieldy.

**Interfaces:**
- Extend `DubbingWorkflowParams` and `ExportWorkflowParams` with optional `requestId?: string`.
- Pipelines consume `telemetry: TelemetrySink`.
- Starting routes pass the current request ID in Workflow params.
- Direct translation/voice routes call `withProviderTelemetry` around actual provider boundaries.

- [ ] **Step 1: Write RED tests for direct provider telemetry**

Successful translation must emit `provider_success` with provider and project/request correlation. Provider failure must emit `provider_failure` with normalized code such as `TRANSLATION_FAILED`/provider-specific code but not the provider's raw response/message.

Voice preview success/failure follows the same contract with provider `elevenlabs`.

- [ ] **Step 2: Instrument direct provider calls**

Wrap only the actual provider call, not validation or persistence:

```ts
const result = await withProviderTelemetry(telemetry, {
  requestId: c.get('requestId'),
  actorId: userId,
  projectId,
  operation: 'translate',
  provider: providerId,
  errorCode: 'TRANSLATION_PROVIDER_FAILED',
}, () => router.translate(...));
```

For compare mode, emit provider-level events for each provider if the router exposes separate boundaries; if not, emit one operation event with provider `translation-router` and keep detailed provider instrumentation inside provider adapters as a follow-up only if it can be done without duplicate events.

- [ ] **Step 3: Write workflow RED tests**

Update fixture params to include `requestId: 'req-workflow'` and inject a recording telemetry sink. Assert:

- ASR success emits provider `deepgram-nova-3` or the injected provider ID.
- translation success emits the injected translation provider ID.
- TTS success emits `elevenlabs`.
- render success emits `ffmpeg-container`.
- provider errors emit normalized failure codes and never raw translated/voice/source text.

- [ ] **Step 4: Pass request ID into workflow creation**

Process/export routes create workflows with:

```ts
params: {
  projectId,
  userId,
  jobId: job.id,
  requestId: c.get('requestId'),
}
```

Keep `requestId` optional in workflow params so historical/retried workflow payloads remain compatible.

- [ ] **Step 5: Instrument dubbing pipeline providers**

Add `telemetry` to `DubbingPipelineDeps`. Wrap `deps.asr.transcribe` and `deps.translation.translateBatch` with `withProviderTelemetry` using `projectId`, `jobId`, `requestId`, provider ID, and normalized codes `ASR_FAILED` and `TRANSLATION_FAILED`.

Do not change Phase 3B `usage.record(started/completed)` ordering or operation keys.

- [ ] **Step 6: Instrument export pipeline providers**

Add `telemetry` to `ExportPipelineDeps`. Wrap:

- `deps.voice.generate` as provider `elevenlabs`, code `VOICE_PROVIDER_FAILED`;
- `deps.media.renderExport` as provider `ffmpeg-container`, code `MEDIA_RENDER_FAILED`.

Do not count artifact-probe recovery as a provider success for TTS generation because no generation call occurred.

- [ ] **Step 7: Wire production telemetry sinks in Workflow classes**

```ts
telemetry: createTelemetry(this.env),
```

No telemetry write is awaited or allowed to fail the workflow.

- [ ] **Step 8: Run workflow/direct-provider tests**

Run:
- `npx vitest run worker/test/dubbing-workflow.test.ts worker/test/export-pipeline.test.ts worker/test/translation*.test.ts worker/test/voice*.test.ts`

Expected: PASS with Phase 3B usage regression expectations unchanged.

- [ ] **Step 9: Commit Task 4**

```bash
git add worker/src/routes worker/src/workflows worker/test
git commit -m "feat: instrument provider operations"
```

---

### Task 5: Extract one owner/share R2 Range streaming helper

**Files:**
- Create: `worker/src/http/media-stream.ts`
- Create: `worker/test/media-stream.test.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: existing export route tests

**Interfaces:**
- Produces `streamMediaObject(bucket, objectKey, request, filename): Promise<Response>`.
- Helper has no knowledge of users, projects, shares, or tokens.

- [ ] **Step 1: Write helper RED tests**

Use a fake R2 readable bucket and assert exact semantics:

```ts
expect(full.status).toBe(200);
expect(full.headers.get('Accept-Ranges')).toBe('bytes');
expect(partial.status).toBe(206);
expect(partial.headers.get('Content-Range')).toBe('bytes 10-19/100');
expect(invalid.status).toBe(416);
expect(invalid.headers.get('Content-Range')).toBe('bytes */100');
```

Also assert `head()` is not called for a non-range full response and that the filename is sanitized/quoted deterministically.

- [ ] **Step 2: Move existing export Range implementation without semantic changes**

Implement:

```ts
export async function streamMediaObject(
  bucket: R2ReadableBucketLike,
  objectKey: string,
  request: Request,
  filename: string,
): Promise<Response> {
  // existing parseByteRange/head/get/header logic from export route
}
```

Retain existing error codes by allowing callers to map a not-found sentinel, or return `EXPORT_OBJECT_NOT_FOUND` only from the owner caller. The low-level helper should not invent authorization errors.

- [ ] **Step 3: Refactor owner export route to call the helper**

Authorization remains:

```ts
const project = await projects.getByIdForUser(projectId, getCurrentUserId());
if (!project) return 404;
if (!project.exportObjectKey) return 409;
return streamMediaObject(bucket, project.exportObjectKey, c.req.raw, `${project.id}-dubbed.mp4`);
```

Emit `export_download` telemetry after the stream response is produced, with access mode `owner`, HTTP status, range flag, request/project IDs, and no object key if avoiding internal storage identifiers is preferred.

- [ ] **Step 4: Run helper + export regressions**

Run:
- `npx vitest run worker/test/media-stream.test.ts worker/test/export*.test.ts`

Expected: PASS, including legacy 200/206/416 owner behavior.

- [ ] **Step 5: Commit Task 5**

```bash
git add worker/src/http/media-stream.ts worker/test/media-stream.test.ts worker/src/routes/export.ts worker/test
git commit -m "refactor: share export media streaming"
```

---

### Task 6: Share-token crypto and D1 repository

**Files:**
- Create: `migrations/0006_export_shares.sql`
- Create: `worker/src/security/share-token.ts`
- Create: `worker/src/db/shares.ts`
- Create: `worker/test/shares.test.ts`

**Interfaces:**
- Produces `createShareSecret(): { token: string; tokenHashPromise: Promise<string>; tokenHint: string }` or an async equivalent returning `{ token, tokenHash, tokenHint }`.
- Produces `hashShareToken(token): Promise<string>` using Web Crypto SHA-256.
- Produces `ShareStore.create/listForProject/revoke/resolveActive`.
- `resolveActive(shareId, tokenHash, now)` requires both public `shareId` and token hash, and only returns unexpired/unrevoked rows.

- [ ] **Step 1: Write migration and repository RED tests**

Tests must prove:

- generated token has at least 32 random bytes of entropy encoded base64url;
- same token hashes deterministically;
- plaintext token is never among values bound to D1 insert;
- list rows expose no `tokenHash` in API-facing mapping;
- resolve lookup requires both `id` and `token_hash`;
- expired, revoked, and unknown rows resolve to `null`;
- revoke is idempotent and owner/project scoped.

Run: `npx vitest run worker/test/shares.test.ts`
Expected: FAIL because modules/table do not exist.

- [ ] **Step 2: Add migration**

```sql
CREATE TABLE export_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  export_object_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_export_shares_project_created
  ON export_shares(project_id, created_at DESC);
```

- [ ] **Step 3: Implement 256-bit base64url secret generation and SHA-256**

```ts
export async function createShareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(bytes);
  return {
    token,
    tokenHash: await hashShareToken(token),
    tokenHint: token.slice(-8),
  };
}
```

Do not use UUIDs as share secrets.

- [ ] **Step 4: Implement repository row mapping and status**

Owner-facing type:

```ts
export type ExportShare = {
  id: string;
  projectId: string;
  tokenHint: string;
  exportObjectKey: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'expired' | 'revoked';
};
```

`token_hash` exists only in internal insert/lookup SQL, never on `ExportShare`.

- [ ] **Step 5: Run repository tests**

Run: `npx vitest run worker/test/shares.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add migrations/0006_export_shares.sql worker/src/security/share-token.ts worker/src/db/shares.ts worker/test/shares.test.ts
git commit -m "feat: add revocable export share persistence"
```

---

### Task 7: Owner share APIs, anonymous shared media, and access telemetry

**Files:**
- Create: `worker/src/routes/shares.ts`
- Create: `worker/test/share-routes.test.ts`
- Modify: `worker/src/app.ts`

**Interfaces:**
- Owner routes mounted under `/api/projects`: `POST /:id/shares`, `GET /:id/shares`, `DELETE /:id/shares/:shareId`.
- Public route mounted under `/api`: `GET /shares/:shareId/media?token=<secret>`.
- Creation returns plaintext `shareUrl` once only; list never returns token/hash/URL.

- [ ] **Step 1: Write owner-management RED tests**

Create tests for:

```ts
POST /api/projects/p1/shares
GET /api/projects/p1/shares
DELETE /api/projects/p1/shares/s1
```

Assert:

- project must belong to current server user;
- export object must exist;
- omitted TTL produces 7-day expiry;
- TTL below 3600 or above 2592000 returns 400;
- response URL shape is `/api/shares/<shareId>/media?token=<plaintext>`;
- response/list never contains `tokenHash`;
- cross-user project/share access is 404;
- second revoke succeeds with revoked status.

- [ ] **Step 2: Implement owner routes**

Creation sequence:

```ts
const project = await projects.getByIdForUser(projectId, userId);
if (!project) return 404;
if (!project.exportObjectKey) return 409;
const ttl = parseShareTtl(body.expiresInSeconds);
const token = await createShareToken();
const share = await shares.create({
  projectId,
  userId,
  tokenHash: token.tokenHash,
  tokenHint: token.tokenHint,
  exportObjectKey: project.exportObjectKey,
  expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
});
const origin = new URL(c.req.url).origin;
return c.json({
  share: publicShare(share),
  shareUrl: `${origin}/api/shares/${encodeURIComponent(share.id)}/media?token=${encodeURIComponent(token.token)}`,
}, 201);
```

Do not persist `shareUrl` or plaintext token.

- [ ] **Step 3: Write anonymous media RED tests**

Cases:

- correct `shareId + token` streams 200;
- Range streams 206;
- invalid Range returns 416;
- wrong token, unknown ID, expired, revoked all return identical `404 SHARE_NOT_FOUND`;
- endpoint does not require login;
- no edit/process/export route accepts the token as authorization;
- `share_access` and successful `export_download` events contain `shareId/projectId` but not raw token or token hash.

- [ ] **Step 4: Implement public share resolution and streaming**

```ts
const rawToken = c.req.query('token')?.trim() ?? '';
if (!rawToken) return c.json(errorBody('SHARE_NOT_FOUND', 'Share not found.'), 404);
const tokenHash = await hashShareToken(rawToken);
const share = await shares.resolveActive(c.req.param('shareId'), tokenHash, new Date());
if (!share) return c.json(errorBody('SHARE_NOT_FOUND', 'Share not found.'), 404);
const started = Date.now();
const response = await streamMediaObject(bucket, share.exportObjectKey, c.req.raw, `${share.projectId}-dubbed.mp4`);
emitTelemetry(...share_access...);
if (response.status === 200 || response.status === 206) emitTelemetry(...export_download accessMode:'share'...);
return response;
```

Never emit `rawToken`, `tokenHash`, query string, or raw URL.

- [ ] **Step 5: Mount share routes with request telemetry middleware already active**

`app.route('/api/projects', createProjectShareRoutes())` and `app.route('/api', createPublicShareRoutes())` or one factory exposing both route groups. Keep owner/project authorization server-derived.

- [ ] **Step 6: Run share route tests and all Worker tests**

Run:
- `npx vitest run worker/test/share-routes.test.ts worker/test/media-stream.test.ts`
- `npx vitest run worker/test`

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add worker/src/routes/shares.ts worker/src/app.ts worker/test/share-routes.test.ts
git commit -m "feat: add revocable shared export access"
```

---

### Task 8: Studio sharing UI, Phase 3C acceptance gate, and final qualification

**Files:**
- Create: `src/features/sharing/shareApi.ts`
- Create: `src/features/sharing/shareApi.test.ts`
- Create: `src/features/sharing/SharePanel.tsx`
- Create: `src/features/sharing/SharePanel.test.tsx`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioTopbar.tsx`
- Modify: relevant Studio CSS file(s)
- Create: `tests/phase3c-safety-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- `createShare(projectId, expiresInSeconds?)` -> `{ share, shareUrl }`.
- `listShares(projectId)` -> share metadata without secret.
- `revokeShare(projectId, shareId)` -> revoked share metadata.
- `SharePanel` supports create, immediate copy, list statuses, revoke, and replacement-link explanation after reload.

- [ ] **Step 1: Write share transport RED tests**

```ts
await createShare('p 1', 604800);
expect(fetch).toHaveBeenCalledWith('/api/projects/p%201/shares', expect.objectContaining({ method: 'POST' }));

await revokeShare('p1', 's/1');
expect(fetch).toHaveBeenCalledWith('/api/projects/p1/shares/s%2F1', expect.objectContaining({ method: 'DELETE' }));
```

Assert non-2xx responses throw stable UI errors and list responses cannot synthesize a URL from tokenHint.

- [ ] **Step 2: Implement `shareApi.ts`**

Use the existing project API fetch/error style. Do not pass user IDs. Keep `shareUrl` only on create response type.

- [ ] **Step 3: Write SharePanel RED tests**

Test:

- panel hidden/disabled until project has `exportObjectKey`;
- create defaults to 7 days;
- one-time returned link renders and Copy calls `navigator.clipboard.writeText`;
- after refresh/list, rows show `active`, `expired`, `revoked` but no reconstructable URL;
- active row can revoke;
- revoked/expired rows explain that a replacement share can be created;
- no social/public-discovery/collaborator UI appears.

- [ ] **Step 4: Implement compact Studio export sharing surface**

Add `canShare`/`onShare` to `StudioTopbar`. When an export exists, render `Tải Dubbing` and a `Chia sẻ` button. `StudioShell` owns `shareOpen` and renders `SharePanel` near the topbar/export area:

```tsx
<StudioTopbar
  ...
  canShare={Boolean(state.project.exportObjectKey)}
  onShare={() => setShareOpen((value) => !value)}
/>
{shareOpen && state.project.exportObjectKey ? (
  <SharePanel projectId={state.project.id} onClose={() => setShareOpen(false)} />
) : null}
```

Do not add dashboard-wide collaboration state.

- [ ] **Step 5: Add Phase 3C source/config acceptance gate**

`tests/phase3c-safety-acceptance.test.mjs` must assert at least:

```js
assert.match(wrangler, /"analytics_engine_datasets"/);
assert.match(wrangler, /"dataset"\s*:\s*"dubflow_events"/);
assert.match(wrangler, /"redact_query_string"\s*:\s*true/);
assert.match(wrangler, /"head_sampling_rate"\s*:\s*0\.05/);
for (const name of ['RATE_LIMIT_PROCESS','RATE_LIMIT_EXPORT','RATE_LIMIT_TRANSLATE','RATE_LIMIT_VOICE','RATE_LIMIT_UPLOAD']) assert.match(wrangler, new RegExp(name));
assert.equal(new Set(namespaceIds).size, 5);
assert.match(sharesMigration, /token_hash TEXT NOT NULL UNIQUE/);
assert.doesNotMatch(shareListRouteSource, /token_hash[^\n]*json|tokenHash[^\n]*return/);
assert.match(publicRouteSource, /\/shares\/:shareId\/media/);
assert.match(publicRouteSource, /query\(['"]token['"]\)/);
```

Also source-scan telemetry modules for forbidden arbitrary payload fields and assert `usage_events`/`credit_balance` are not mutated by Phase 3C telemetry/rate-limit modules.

Append this file to `verify:deploy-config` in `package.json`.

- [ ] **Step 6: Update deployment status without claiming production runtime qualification**

Document:

- Phase 3C source/CI qualification state;
- exact rate-limit classes and observability bindings;
- anonymous revocable share contract;
- production runtime still UNQUALIFIED until Container credentials/live provider-media fixtures are proven.

- [ ] **Step 7: Run focused UI tests**

Run:
- `npx vitest run src/features/sharing/shareApi.test.ts src/features/sharing/SharePanel.test.tsx src/app/StudioTopbar.test.tsx src/app/StudioShell.test.tsx`

Expected: PASS.

- [ ] **Step 8: Run full exact-head verification**

Run:
- `npm run verify`
- `npx wrangler deploy --dry-run`

Expected: all deploy-config/acceptance tests, Vitest suites, TypeScript build, Vite build, and Wrangler config validation PASS.

- [ ] **Step 9: Push/CI qualification and PR merge discipline**

On the exact implementation head:

1. require push CI FULL GREEN including Verify, Wrangler dry-run, CJK font, reference screenshots, and artifact upload;
2. re-read live `main`;
3. if `main` advanced, reconcile it into the carrier without force push and rerun exact-head full CI;
4. open Phase 3C PR to `main` with explicit out-of-scope and runtime-unqualified notes;
5. require PR-triggered exact-head FULL GREEN;
6. race-check `main`, PR head, and mergeability;
7. merge with merge method `merge` and exact expected head SHA;
8. verify `main` points to the returned merge SHA;
9. require post-merge `main` CI FULL GREEN before declaring Phase 3C complete.

- [ ] **Step 10: Commit Task 8**

```bash
git add src/features/sharing src/app/StudioShell.tsx src/app/StudioTopbar.tsx src/styles tests/phase3c-safety-acceptance.test.mjs package.json docs/deployment-status.md
git commit -m "feat: complete Phase 3C safety and sharing UX"
```

---

## Plan Self-Review

### Spec coverage

- Observability / Workers Logs / Traces / Analytics Engine: Task 1.
- Structured redacted event contract and request correlation: Tasks 1 and 4.
- Five Cloudflare Rate Limiting namespaces and exact limits: Task 2.
- Authorization/validation-before-limit and 429-before-expensive-work: Task 3.
- Provider success/failure telemetry in direct routes and Workflows: Task 4.
- One shared owner/share Range implementation: Task 5.
- 256-bit token, SHA-256-only persistence, expiry/revoke, immutable export binding: Task 6.
- Owner share APIs and anonymous read-only shared media: Task 7.
- `share_access` / `export_download` telemetry without token leakage: Tasks 5 and 7.
- Studio create/copy/list/revoke UX with one-time-link semantics: Task 8.
- Acceptance gate, exact-head CI/PR/merge/post-merge discipline, runtime-unqualified note: Task 8.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, or unspecified edge-case steps are present. The only future-facing statement is the approved non-goal that an eventual real regenerate-voice endpoint will reuse the `voice` operation class; Phase 3C does not create that endpoint.

### Type/interface consistency

- `TelemetrySink`, `TelemetryEvent`, and `withProviderTelemetry` are defined in Task 1 and consumed unchanged in Tasks 3–7.
- `RateLimitOperation` and `checkRateLimit` are defined in Task 2 and consumed in Task 3.
- Workflow `requestId?: string` is introduced in Task 4 and passed only by process/export start routes.
- `streamMediaObject` is defined in Task 5 and consumed by owner export and public sharing in Task 7.
- Share owner-facing types never expose token hash; `shareUrl` exists only on creation response and UI transient state.
