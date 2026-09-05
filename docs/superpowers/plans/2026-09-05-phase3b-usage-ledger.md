# Phase 3B Usage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, idempotent internal usage metering and authorized usage summaries for ASR, translation, TTS, and render without introducing pricing enforcement or payments.

**Architecture:** Extend the existing D1 `usage_events` schema with retry-safe operation identity and event phase, implement one focused usage repository, inject a narrow usage meter into dubbing/export pipelines, then expose authorized summary routes and a compact dashboard summary. Completed usage drives totals; started-only events remain available for later observability.

**Tech Stack:** React 19 + TypeScript + Vite, Hono Worker API, Cloudflare D1, Cloudflare Workflows, Vitest, existing GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-05-phase3b-usage-ledger-design.md`

## Global Constraints

- `cost_basis` remains `0` in Phase 3B.
- `users.credit_balance` is read-only in Phase 3B; do not decrement, reserve, or enforce credits.
- Meter only provider/render work actually attempted by the pipeline.
- Automatic Workflow step replay must not duplicate a `(operation_key, phase)` event.
- Explicit user job retry uses the incremented durable `retry_count` and therefore a distinct operation key generation.
- Completed summaries exclude started-only rows.
- Reused durable TTS output must not create new TTS usage.
- Existing Studio Pro V2.5 autosave/CAS and Phase 3A job semantics must remain unchanged.
- Production Cloudflare runtime qualification remains separate from source/CI qualification.

---

### Task 1: Usage Schema and Idempotent Repository

**Files:**
- Create: `migrations/0005_usage_event_idempotency.sql`
- Create: `worker/src/db/usage.ts`
- Create: `worker/test/usage.test.ts`

**Interfaces:**

```ts
export type UsageKind = 'asr_audio_minute' | 'translation_character' | 'tts_character' | 'render_minute';
export type UsagePhase = 'started' | 'completed';
export type UsageRecordInput = {
  userId: string;
  projectId: string;
  jobId: string;
  kind: UsageKind;
  units: number;
  provider: string;
  phase: UsagePhase;
  operationKey: string;
};
export type UsageTotals = {
  asrAudioMinutes: number;
  translationCharacters: number;
  ttsCharacters: number;
  renderMinutes: number;
};
export type UsageSummary = { totals: UsageTotals; providers: Record<string, UsageTotals> };
export interface UsageStore {
  record(input: UsageRecordInput): Promise<UsageEvent>;
  summarizeForUser(userId: string): Promise<UsageSummary>;
  summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>;
  getCreditBalance(userId: string): Promise<number>;
}
```

- [ ] **Step 1: Write migration and repository RED tests**

Add tests covering duplicate operation phase, coexistence of started/completed, completed-only summaries, provider precision, project authorization, and credit balance.

Representative assertions:

```ts
const first = await repo.record(input);
const second = await repo.record(input);
expect(second.id).toBe(first.id);

await repo.record({ ...input, phase: 'started' });
await repo.record({ ...input, phase: 'completed' });
expect(await repo.summarizeForUser('u1')).toEqual({
  totals: expect.objectContaining({ asrAudioMinutes: 1.25 }),
  providers: expect.objectContaining({ deepgram: expect.objectContaining({ asrAudioMinutes: 1.25 }) }),
});
```

- [ ] **Step 2: Run focused test RED**

Run: `npx vitest run worker/test/usage.test.ts`
Expected: FAIL because `worker/src/db/usage.ts` does not exist.

- [ ] **Step 3: Implement migration**

`migrations/0005_usage_event_idempotency.sql`:

```sql
ALTER TABLE usage_events ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE usage_events ADD COLUMN phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'));
ALTER TABLE usage_events ADD COLUMN operation_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_operation_phase
  ON usage_events(operation_key, phase)
  WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_project_created
  ON usage_events(project_id, created_at DESC);
```

- [ ] **Step 4: Implement `UsageRepository`**

`record()` validates finite non-negative units and non-empty provider/operation key, uses `INSERT OR IGNORE`, then reads the canonical row by `(operation_key, phase)`. `summarizeForUser` and `summarizeForProject` query only `phase='completed'` rows and accumulate without early rounding.

- [ ] **Step 5: Run repository tests GREEN**

Run: `npx vitest run worker/test/usage.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0005_usage_event_idempotency.sql worker/src/db/usage.ts worker/test/usage.test.ts
git commit -m "feat: add idempotent usage ledger"
```

---

### Task 2: Meter Dubbing ASR and Translation

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`

**Interfaces:**

Add narrow pipeline dependency:

```ts
type UsageMeter = Pick<UsageStore, 'record'>;
```

The pipeline must read the canonical job once after authorization:

```ts
const job = await deps.jobs.getForProject(params.projectId, params.jobId, params.userId);
if (!job) throw new Error('Job not found.');
const generation = job.retryCount;
```

Therefore extend `PipelineJobs` to include `getForProject`.

- [ ] **Step 1: Write RED tests for ASR idempotency and explicit retry generation**

For a chunk `{ objectKey:'chunk-1', durationMs:90000 }`, assert the usage meter receives:

```ts
{
  kind: 'asr_audio_minute',
  units: 1.5,
  phase: 'started',
  operationKey: 'job:j1:retry:0:asr:chunk-1'
}
```

and a matching completed event after successful transcription. Run the pipeline twice with the same generation against an idempotent fake meter and assert one canonical started/completed pair. With retryCount `1`, assert a different key.

- [ ] **Step 2: Run dubbing tests RED**

Run: `npx vitest run worker/test/dubbing-workflow.test.ts`
Expected: FAIL because usage dependency and events do not exist.

- [ ] **Step 3: Implement ASR metering**

Before `deps.asr.transcribe`, record `started`; after success record `completed`. Units come from `chunk.durationMs / 60000`. Provider ID must come from an injected stable `asrProviderId` string supplied by `DubbingWorkflow` from the configured adapter selection.

- [ ] **Step 4: Implement translation metering**

Compute source characters as:

```ts
const units = [...batch.map((item) => item.sourceText).join('')].length;
```

Record one started event with provider `translation-router`. After success, group returned results by `result.provider`; for each provider write a completed row with provider-specific source-character units and operation key suffix `:provider:${provider}`. Do not use translated-text length.

- [ ] **Step 5: Wire `UsageRepository` in `DubbingWorkflow`**

Instantiate `new UsageRepository(this.env.DB)` and pass it into the pipeline.

- [ ] **Step 6: Run dubbing tests GREEN**

Run: `npx vitest run worker/test/dubbing-workflow.test.ts worker/test/usage.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full verify and commit**

Run: `npm run verify`
Expected: PASS.

```bash
git add worker/src/workflows/pipeline.ts worker/src/workflows/DubbingWorkflow.ts worker/test/dubbing-workflow.test.ts
git commit -m "feat: meter dubbing provider usage"
```

---

### Task 3: Meter TTS and Final Render

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/test/export-pipeline.test.ts`

**Interfaces:**

`ExportPipelineDeps.projects.getByIdForUser` must expose durable `durationMs`; `jobs` must expose `getForProject`; add `usage: Pick<UsageStore,'record'>`.

- [ ] **Step 1: Write RED tests for TTS generation/reuse**

For a newly generated segment, assert started/completed `tts_character` events using trimmed Unicode translated-text characters and provider `elevenlabs`.

For:

```ts
{ voiceStatus: 'completed', dubbedObjectKey: 'projects/p1/dubbed/s1.mp3' }
```

assert no TTS usage records are written.

- [ ] **Step 2: Write RED render-meter test**

With durable `durationMs: 150000`, assert render started/completed events with `units: 2.5`, provider `ffmpeg-container`, key `job:j2:retry:0:render:final`.

- [ ] **Step 3: Run export tests RED**

Run: `npx vitest run worker/test/export-pipeline.test.ts`
Expected: FAIL because usage metering does not exist.

- [ ] **Step 4: Implement TTS and render metering**

Only meter inside the `!objectKey` generation branch. Render duration must come from project metadata and must be finite and positive before recording render usage.

- [ ] **Step 5: Wire `UsageRepository` in `ExportWorkflow`**

Instantiate the repository and inject it.

- [ ] **Step 6: Run export tests GREEN**

Run: `npx vitest run worker/test/export-pipeline.test.ts worker/test/usage.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full verify and commit**

Run: `npm run verify`
Expected: PASS.

```bash
git add worker/src/workflows/exportPipeline.ts worker/src/workflows/ExportWorkflow.ts worker/test/export-pipeline.test.ts
git commit -m "feat: meter voice and render usage"
```

---

### Task 4: Authorized Usage Summary API

**Files:**
- Create: `worker/src/routes/usage.ts`
- Create: `worker/test/usage-routes.test.ts`
- Modify: `worker/src/app.ts`

**Interfaces:**

```ts
export type UsageRouteDeps = { makeUsage?: (env: Env) => UsageStore };
export function createUsageRoutes(deps: UsageRouteDeps = {}): Hono<{ Bindings: Env }>;
```

Routes:
- `GET /api/usage`
- `GET /api/projects/:id/usage`

- [ ] **Step 1: Write route tests RED**

Assert user summary includes credit balance; project summary omits it; unauthorized project summary returns `404`; malformed repository errors return structured `500` without exposing SQL details.

- [ ] **Step 2: Run route tests RED**

Run: `npx vitest run worker/test/usage-routes.test.ts`
Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement routes**

Use `getCurrentUserId()` only; never accept client user ID. `summarizeForProject` must enforce ownership inside the repository query.

- [ ] **Step 4: Mount routes**

In `worker/src/app.ts`:

```ts
app.route('/api', createUsageRoutes());
```

The usage router defines `/usage` and `/projects/:id/usage` relative paths.

- [ ] **Step 5: Run route + full verification GREEN**

Run: `npx vitest run worker/test/usage-routes.test.ts worker/test/usage.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/usage.ts worker/test/usage-routes.test.ts worker/src/app.ts
git commit -m "feat: expose authorized usage summaries"
```

---

### Task 5: Dashboard Usage Client and UI

**Files:**
- Create: `src/features/projects/usageApi.ts`
- Create: `src/features/projects/usageApi.test.ts`
- Create: `src/features/projects/UsageSummaryPanel.tsx`
- Create: `src/features/projects/UsageSummaryPanel.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/features/projects/ProjectDashboard.tsx`
- Modify: `src/styles/project-dashboard.css`

**Interfaces:**

```ts
export type CloudUsageSummary = {
  creditBalance?: number;
  totals: UsageTotals;
  providers: Record<string, UsageTotals>;
};
export function getUsageSummary(): Promise<CloudUsageSummary>;
```

`ProjectDashboardProps` gains independent usage state:

```ts
usage?: CloudUsageSummary;
usageLoading: boolean;
usageError: string;
```

- [ ] **Step 1: Write API and component RED tests**

Assert `/api/usage` fetch, rendering `50,000` informational credits, `1.25` ASR minutes, integer character counts, provider rows, and independent error rendering.

- [ ] **Step 2: Run frontend tests RED**

Run: `npx vitest run src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.test.tsx`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement API client and panel**

Minutes display with `toLocaleString('vi-VN', { maximumFractionDigits: 2 })`; characters use integer locale formatting. Do not mutate totals for presentation.

- [ ] **Step 4: Integrate dashboard without coupling project/job loading**

`App` loads usage independently when `view==='dashboard'`. A usage failure updates only `usageError`; existing project/job state remains visible.

- [ ] **Step 5: Run frontend + full verification GREEN**

Run: `npx vitest run src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.test.tsx src/features/projects/ProjectDashboard.test.tsx src/app/AppDashboard.test.tsx && npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/projects/usageApi.ts src/features/projects/usageApi.test.ts src/features/projects/UsageSummaryPanel.tsx src/features/projects/UsageSummaryPanel.test.tsx src/app/App.tsx src/features/projects/ProjectDashboard.tsx src/styles/project-dashboard.css
git commit -m "feat: show provider usage on dashboard"
```

---

### Task 6: Exact-Head Qualification and Merge

**Files:**
- No product-code changes unless CI identifies an evidence-backed regression.

- [ ] **Step 1: Run repository verification**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 2: Push exact branch head and open Draft PR**

PR scope must explicitly state that pricing, credit decrement/enforcement, rate limits, observability policy, and sharing remain deferred.

- [ ] **Step 3: Require exact-head GitHub Actions full GREEN**

Required: source/tests/build, Wrangler dry-run, CJK font setup, both reference screenshots, artifact upload.

- [ ] **Step 4: Re-read live `main`**

If `main` advanced, reverse-sync current `main` into the carrier with a merge commit. Do not force, rebase, or choose ours/theirs blindly.

- [ ] **Step 5: Require post-sync exact-head full GREEN**

No pre-sync run qualifies the new head.

- [ ] **Step 6: Mark PR ready and merge with expected head SHA**

Use merge commit; expected head SHA must equal the exact qualified carrier SHA.

- [ ] **Step 7: Verify post-merge `main`**

Confirm `main` points at the merge commit and require its push CI to complete successfully with the same full gate.

- [ ] **Step 8: Record status**

Phase 3B source/CI may be marked complete only after post-merge GREEN. Production runtime remains UNQUALIFIED unless separately qualified.
