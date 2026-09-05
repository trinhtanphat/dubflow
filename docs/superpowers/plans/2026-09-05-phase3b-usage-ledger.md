# Phase 3B Usage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, idempotent internal usage metering and authorized usage summaries for ASR, translation, generated TTS audio, and final render without payments, pricing enforcement, or credit depletion.

**Architecture:** Keep D1 `usage_events` as the append-only source of truth, extend it with deterministic operation identity and `started|completed` phases, and inject a narrow usage interface at durable workflow boundaries. Canonical API/storage units are seconds for ASR/TTS/render and Unicode source characters for translation; UI may convert seconds to minutes only for presentation. TTS completion is measured from the persisted generated audio artifact via the existing FFmpeg Container `probe(...)` contract, and retries must never regenerate already-durable voice solely to recover metering.

**Tech Stack:** React 19 + TypeScript + Vite, Hono Worker API, Cloudflare D1, Cloudflare Workflows, R2, FFmpeg Cloudflare Container, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-phase3b-usage-ledger-design.md`

## Global Constraints

- Canonical base units are exactly: ASR audio **seconds**, translation **Unicode source characters**, generated TTS audio **seconds**, render **seconds**.
- Canonical kinds are exactly `asr_audio_second`, `translation_character`, `tts_audio_second`, `render_second`.
- Canonical summary fields are exactly `asrAudioSeconds`, `translationCharacters`, `ttsAudioSeconds`, `renderSeconds`.
- `cost_basis` stays `0` throughout Phase 3B.
- `users.credit_balance` is informational/read-only; do not decrement, reserve, price, or enforce credits.
- Automatic Workflow replay must not duplicate a logical `(operation_key, phase)` event.
- Explicit user retry uses durable `jobs.retry_count`; a new retry generation therefore has distinct operation keys.
- Operation keys are server-generated and include provider: `job:{jobId}:retry:{retryCount}:{stage}:{item}:{provider}`.
- Completed summaries include only `phase='completed'`; started-only rows never inflate totals.
- A pre-existing durable TTS artifact is not newly metered.
- A current-generation TTS operation with `started` but no `completed` reuses/probes the durable artifact and must not call voice generation again merely to recover metering.
- Usage recording failures are not silently swallowed as qualification success.
- Studio Pro V2.5 CAS/autosave and Phase 3A durable job/retry/cancel semantics remain unchanged.
- No payment UI, upgrade CTA, quota enforcement, provider price table, observability policy, rate limiting, or public share controls in this plan.
- Production runtime qualification remains separate from source/CI qualification while the documented Cloudflare Containers credential/live-fixture gates remain unresolved.

## Current Carrier Reconciliation

The carrier already contains partial implementation produced against an older minute-based draft. Treat those commits as an implementation checkpoint, not as the accepted contract. Before continuing to API/UI, Task 1 and Task 2 must convert all stale minute kinds/fields/calculations to the approved base-unit spec. Do not preserve compatibility aliases for the unmerged Phase 3B draft because they have never shipped on `main`.

---

### Task 1: Reconcile Usage Schema/Repository Contract to Canonical Base Units

**Files:**
- Existing: `migrations/0005_usage_event_idempotency.sql`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/test/usage.test.ts`

**Consumes:** existing `usage_events` table plus migration columns `job_id`, `phase`, `operation_key` and unique `(operation_key, phase)` index.

**Produces:**

```ts
export type UsageKind =
  | 'asr_audio_second'
  | 'translation_character'
  | 'tts_audio_second'
  | 'render_second';

export type UsageTotals = {
  asrAudioSeconds: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  renderSeconds: number;
};

export interface UsageStore {
  record(input: UsageRecordInput): Promise<UsageEvent>;
  getByOperation(operationKey: string, phase: UsagePhase): Promise<UsageEvent | null>;
  summarizeForUser(userId: string): Promise<UsageSummary>;
  summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>;
  getCreditBalance(userId: string): Promise<number>;
}
```

- [ ] **Step 1: Convert repository tests to canonical seconds and verify RED against stale code**

Use representative completed events:

```ts
const asr = {
  userId: 'u1', projectId: 'p1', jobId: 'j1',
  kind: 'asr_audio_second' as const,
  units: 75.125,
  provider: 'deepgram',
  phase: 'completed' as const,
  operationKey: 'job:j1:retry:0:asr:chunk-1:deepgram',
};

await repo.record(asr);
await repo.record({
  ...asr,
  kind: 'render_second',
  units: 142.375,
  provider: 'ffmpeg-container',
  operationKey: 'job:j1:retry:0:render:final:ffmpeg-container',
});

expect((await repo.summarizeForUser('u1')).totals).toEqual({
  asrAudioSeconds: 75.125,
  translationCharacters: 0,
  ttsAudioSeconds: 0,
  renderSeconds: 142.375,
});
```

Run: `npx vitest run worker/test/usage.test.ts`

Expected: RED because current repository still exposes minute-based ASR/render kinds and summary field names.

- [ ] **Step 2: Implement the minimal repository rename/conversion**

Change only the unmerged Phase 3B contract:

```ts
const USAGE_KINDS = new Set<UsageKind>([
  'asr_audio_second',
  'translation_character',
  'tts_audio_second',
  'render_second',
]);

function emptyTotals(): UsageTotals {
  return {
    asrAudioSeconds: 0,
    translationCharacters: 0,
    ttsAudioSeconds: 0,
    renderSeconds: 0,
  };
}
```

`addUnits` maps each canonical kind to its canonical field. Keep numeric accumulation unrounded.

- [ ] **Step 3: Preserve idempotency/authorization coverage**

Tests must still prove:

```ts
const first = await repo.record(asr);
const second = await repo.record(asr);
expect(second.id).toBe(first.id);

await repo.record({ ...asr, phase: 'started' });
expect(await repo.summarizeForProject('p1', 'u2'))
  .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
expect(await repo.getCreditBalance('u1')).resolves.toBe(50000);
```

- [ ] **Step 4: Run focused GREEN and full verification**

Run: `npx vitest run worker/test/usage.test.ts`

Expected: PASS.

Run: `npm run verify`

Expected: any remaining failures must be only downstream stale minute-based Phase 3B references; legacy non-Phase-3B suites must not regress.

- [ ] **Step 5: Commit Task 1**

```bash
git add worker/src/db/usage.ts worker/test/usage.test.ts migrations/0005_usage_event_idempotency.sql
git commit -m "fix: normalize Phase 3B usage base units"
```

---

### Task 2: Reconcile Dubbing ASR and Translation Metering

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`

**Consumes:** `UsageStore.record`, canonical durable job `retryCount`, `asrCapabilities(...).provider`, current translation provider ID.

**Produces:** ASR seconds and translation-character `started/completed` rows with provider-qualified operation keys.

- [ ] **Step 1: Write/convert RED ASR contract tests**

For a 90,000 ms chunk require:

```ts
expect(records).toContainEqual(expect.objectContaining({
  kind: 'asr_audio_second',
  units: 90,
  provider: 'deepgram',
  phase: 'started',
  operationKey: 'job:j1:retry:0:asr:chunk-1:deepgram',
}));
expect(records).toContainEqual(expect.objectContaining({
  kind: 'asr_audio_second',
  units: 90,
  phase: 'completed',
}));
```

Repeat with `retryCount: 1` and require `retry:1` in the key.

Run: `npx vitest run worker/test/dubbing-workflow.test.ts`

Expected: RED while pipeline still divides duration by `60000` and emits `asr_audio_minute`.

- [ ] **Step 2: Implement ASR base-unit correction**

Inside the existing deterministic ASR Workflow step:

```ts
const units = chunk.durationMs / 1000;
const key = operationKey(params.jobId, retryCount, 'asr', chunk.objectKey, asrProvider);
await deps.usage.record({ ...common, kind: 'asr_audio_second', units, phase: 'started' });
const result = await deps.asr.transcribe(audio, { sourceLanguage: project.sourceLanguage });
await deps.usage.record({ ...common, kind: 'asr_audio_second', units, phase: 'completed' });
```

Do not alter ASR chunking, cancellation, normalization, or durable segment persistence behavior.

- [ ] **Step 3: Lock translation metering to actual invocation input/provider**

For the current direct Workers AI dubbing translation path, count Unicode source characters only:

```ts
const units = Array.from(items.map((item) => item.text).join('')).length;
const key = operationKey(params.jobId, retryCount, 'translation', `batch-${offset}`, translationProvider);
```

Require one `started` and one `completed` row for the actual provider invocation. If result provider disagrees with the injected provider, fail closed rather than attributing usage to a synthetic/mismatched provider.

- [ ] **Step 4: Keep workflow dependency wiring canonical**

`DubbingWorkflow` must pass:

```ts
usage: new UsageRepository(this.env.DB),
asrProviderId: asrCapabilities(this.env.DEEPGRAM_API_KEY).provider,
translationProviderId: 'workers-ai',
```

No client-supplied provider IDs enter usage keys.

- [ ] **Step 5: Run GREEN verification and commit**

Run: `npx vitest run worker/test/dubbing-workflow.test.ts worker/test/usage.test.ts`

Expected: PASS.

Run: `npm run verify`

Expected: PASS except any not-yet-reconciled export/API/UI Phase 3B RED tests introduced by later tasks.

```bash
git add worker/src/workflows/pipeline.ts worker/src/workflows/DubbingWorkflow.ts worker/test/dubbing-workflow.test.ts
git commit -m "fix: meter dubbing usage in canonical units"
```

---

### Task 3: Meter Generated TTS Duration and Final Render in Seconds

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/test/export-pipeline.test.ts`

**Consumes:** `UsageStore.record`, `UsageStore.getByOperation`, canonical job retry count, `MediaProcessor.probe`, `renderExport`, durable project `durationMs`.

**Produces:** measured `tts_audio_second` and canonical `render_second` events.

- [ ] **Step 1: Add RED tests for newly generated TTS measurement**

Require this sequence for a segment without reusable audio:

```ts
expect(records[0]).toMatchObject({
  kind: 'tts_audio_second', provider: 'elevenlabs', phase: 'started', units: 0,
});
expect(calls).toContain('voice.generate');
expect(calls).toContain('bucket.put');
expect(calls).toContain('segments.setVoiceResult');
expect(calls).toContain('media.probe');
expect(records.at(-1)).toMatchObject({
  kind: 'tts_audio_second', provider: 'elevenlabs', phase: 'completed', units: 2.375,
});
```

The fake `media.probe` returns `{ durationMs: 2375 }` for the persisted dubbed object key.

- [ ] **Step 2: Add RED recovery/reuse tests**

Case A: pre-existing valid `voiceStatus:'completed'` + dubbed object key and no current-generation `started` row => no TTS usage and no generation.

Case B: same durable object key plus current-generation `started` row but no `completed` row => call `media.probe`, record completed duration, and assert `voice.generate` is never called.

```ts
expect(voice.generate).not.toHaveBeenCalled();
expect(media.probe).toHaveBeenCalledWith('projects/p1/dubbed/s1.mp3');
```

- [ ] **Step 3: Add RED final-render seconds test**

For `project.durationMs = 150000` require:

```ts
expect(records).toContainEqual(expect.objectContaining({
  kind: 'render_second',
  units: 150,
  provider: 'ffmpeg-container',
  phase: 'started',
  operationKey: 'job:j2:retry:0:render:final:ffmpeg-container',
}));
```

Completed is recorded only after a valid project-scoped export key is returned.

- [ ] **Step 4: Implement TTS artifact probing without regeneration**

Extend export media dependency:

```ts
media: Pick<MediaProcessor, 'probe' | 'renderExport'>;
usage: Pick<UsageStore, 'record' | 'getByOperation'>;
```

For a newly generated artifact: write `started` with zero units, generate/persist/set segment result, probe the durable object key, then write `completed` with `durationMs / 1000`.

Before generating, query the current operation's `started`/`completed` rows. If a durable artifact exists and `started` exists but `completed` does not, recover by probing and completing usage rather than regenerating.

- [ ] **Step 5: Implement render seconds from canonical project duration**

Require positive finite `project.durationMs`; compute:

```ts
const units = project.durationMs / 1000;
```

Never infer render usage from segments/subtitle span.

- [ ] **Step 6: Wire ExportWorkflow and verify GREEN**

`ExportWorkflow` injects the same `UsageRepository` instance into export pipeline dependencies and exposes media `probe` via `ContainerMediaProcessor`.

Run: `npx vitest run worker/test/export-pipeline.test.ts worker/test/usage.test.ts`

Expected: PASS.

Run: `npm run verify`

Expected: PASS before starting HTTP/UI work.

- [ ] **Step 7: Commit Task 3**

```bash
git add worker/src/workflows/exportPipeline.ts worker/src/workflows/ExportWorkflow.ts worker/test/export-pipeline.test.ts
git commit -m "feat: meter voice and render usage in seconds"
```

---

### Task 4: Authorized Usage Summary API

**Files:**
- Create: `worker/src/routes/usage.ts`
- Create: `worker/test/usage-routes.test.ts`
- Modify: `worker/src/app.ts`

**Produces:**

```ts
GET /api/usage
// -> { creditBalance, totals, providers }

GET /api/projects/:id/usage
// -> { totals, providers }
```

- [ ] **Step 1: Write route RED tests**

User-level response uses canonical fields:

```ts
expect(await response.json()).toEqual({
  creditBalance: 50000,
  totals: {
    asrAudioSeconds: 90,
    translationCharacters: 1200,
    ttsAudioSeconds: 35.5,
    renderSeconds: 150,
  },
  providers: expect.any(Object),
});
```

Project route returns 404 for `UsageAccessError('PROJECT_NOT_FOUND', ...)`. Generic errors return structured 500 without SQL/error internals.

- [ ] **Step 2: Run route tests RED**

Run: `npx vitest run worker/test/usage-routes.test.ts`

Expected: FAIL because routes are not yet mounted/implemented.

- [ ] **Step 3: Implement routes with server-derived identity**

Use only `getCurrentUserId()`; never accept arbitrary `userId` from query/body. Create/inject `UsageRepository(env.DB)` through a small testable dependency factory.

- [ ] **Step 4: Mount and verify**

Mount under `/api` in `worker/src/app.ts`. Run:

`npx vitest run worker/test/usage-routes.test.ts worker/test/usage.test.ts`

Then: `npm run verify`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add worker/src/routes/usage.ts worker/test/usage-routes.test.ts worker/src/app.ts
git commit -m "feat: expose authorized usage summaries"
```

---

### Task 5: Dashboard Usage Client and Isolated Summary UI

**Files:**
- Create: `src/features/projects/usageApi.ts`
- Create: `src/features/projects/usageApi.test.ts`
- Create: `src/features/projects/UsageSummaryPanel.tsx`
- Create: `src/features/projects/UsageSummaryPanel.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/features/projects/ProjectDashboard.tsx`
- Modify: `src/styles/project-dashboard.css`

**Consumes:** canonical seconds-based API summary.

- [ ] **Step 1: Write API/component RED tests**

Require `/api/usage` and canonical client shape:

```ts
expect(summary.totals).toEqual({
  asrAudioSeconds: 90,
  translationCharacters: 1200,
  ttsAudioSeconds: 35.5,
  renderSeconds: 150,
});
```

Panel must render informational credits, usage time, translation characters, provider breakdown, loading state, and isolated usage error.

- [ ] **Step 2: Run frontend RED**

Run: `npx vitest run src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.test.tsx`

Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement seconds-to-display conversion only in UI**

Keep API values untouched. Presentation helper may convert large time values:

```ts
function formatUsageTime(seconds: number): string {
  if (seconds >= 60) return `${(seconds / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} phút`;
  return `${seconds.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} giây`;
}
```

Translation character counts use integer locale formatting. Do not display fake currency/cost.

- [ ] **Step 4: Integrate independently from project/job loading**

`App` loads usage separately when dashboard is active. A usage request failure updates only usage error state; persisted project/job rows remain visible and usable.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.test.tsx src/features/projects/ProjectDashboard.test.tsx`

Then: `npm run verify`

Expected: PASS.

```bash
git add src/features/projects/usageApi.ts src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.tsx src/features/projects/UsageSummaryPanel.test.tsx src/app/App.tsx src/features/projects/ProjectDashboard.tsx src/styles/project-dashboard.css
git commit -m "feat: show usage summary on dashboard"
```

---

### Task 6: Source Acceptance Gate, Documentation, and Exact-Head Qualification

**Files:**
- Modify/Create as appropriate: `tests/phase3b-usage-acceptance.test.mjs`
- Modify: `docs/deployment-status.md`

- [ ] **Step 1: Add source acceptance assertions**

The acceptance gate must fail if source regresses to minute-based canonical contracts or TTS-character accounting. Representative assertions:

```js
expect(usageSource).toMatch(/asr_audio_second/);
expect(usageSource).toMatch(/tts_audio_second/);
expect(usageSource).toMatch(/render_second/);
expect(usageSource).not.toMatch(/asr_audio_minute|tts_character|render_minute/);
expect(exportSource).toMatch(/durationMs\s*\/\s*1000/);
```

Also assert no Phase 3B credit decrement/write path exists.

- [ ] **Step 2: Update deployment/source qualification docs**

Document Phase 3B as source-qualified only: durable idempotent usage events, informational credits, authorized summaries, no pricing/quota enforcement. Production runtime remains UNQUALIFIED until independent Cloudflare credentials and real-media fixture gates pass.

- [ ] **Step 3: Run full verification**

Run: `npm run verify`

Expected: all source, TypeScript/Vite, Worker and regression tests PASS.

- [ ] **Step 4: Open/update Draft PR and wait for exact-head CI**

PR body must state explicit deferrals: pricing/credit enforcement, rate limits, observability policy, sharing/download permissions, production runtime qualification.

Require exact-head GitHub Actions GREEN for the full repository contract including Wrangler dry-run, CJK setup, both reference screenshots, and artifact upload.

- [ ] **Step 5: Reconcile live main non-force if needed**

Immediately before merge, re-read `main`. If `main` advanced, use a reverse-sync/merge reconciliation rather than force-moving the carrier or discarding concurrent changes. Rerun exact-head CI after reconciliation.

- [ ] **Step 6: Merge with expected head and verify main**

Merge only after the current exact carrier head is fully GREEN. Use `expected_head_sha` and a merge commit. Verify new `main` contains the merge and require post-merge `main` CI FULL GREEN.

- [ ] **Step 7: Keep production runtime fail-closed**

Do not dispatch repeated production deployment while the documented Containers credential blocker remains unresolved. Source GREEN is not a production-runtime PASS.
