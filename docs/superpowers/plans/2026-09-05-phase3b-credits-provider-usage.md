# Phase 3B Credits Ledger + Provider Usage Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a replay-safe internal credits ledger, provider usage metrics, and dashboard usage visibility without introducing payments or hard credit enforcement.

**Architecture:** Extend the existing D1 `usage_events` table and add a focused UsageRepository. Meter successful expensive work at Workflow/route orchestration boundaries where user/project/job context exists, using deterministic workflow-attempt idempotency keys. Expose an account summary API and render it in the existing ProjectDashboard.

**Tech Stack:** React 19 + TypeScript + Vite, Hono Worker API, Cloudflare D1 + Workflows, Vitest, Node source acceptance tests, GitHub Actions exact-head CI.

**Spec:** `docs/superpowers/specs/2026-09-05-phase3b-credits-provider-usage-design.md`

## Global Constraints

- Credits are internal measurement only in Phase 3B; no payment system and no hard paywall.
- `users.credit_balance` remains allocated credits; used/remaining/overage are derived from append-only usage events.
- Workflow replay for the same `jobId + usageAttempt + stage` must not duplicate usage rows.
- Manual retry is a new `usageAttempt` and may record new provider work.
- Record usage only after successful provider work; malformed/failed calls create no usage row.
- Existing V2.5 optimistic concurrency, Phase 3A job retry/cancel semantics, export invalidation, and dashboard navigation remain unchanged.
- Phase 3C observability/rate limits and Phase 3D share/download are out of scope.
- Production deployment remains manual-only; source/CI GREEN is not runtime qualification.

---

### Task 1: Usage Domain, Migration, and Replay-Safe Repository

**Files:**
- Create: `migrations/0005_usage_ledger.sql`
- Create: `worker/src/domain/usage.ts`
- Create: `worker/src/db/usage.ts`
- Create: `worker/test/usage.test.ts`

**Interfaces:**
- `UsageKind = 'asr_audio_seconds' | 'translation_characters' | 'tts_characters' | 'render_seconds'`
- `creditsForUsage(kind, units): { credits: number; creditRate: number }`
- `UsageStore.record(input): Promise<{ event: UsageEvent; inserted: boolean }>`
- `UsageStore.summaryForUser(userId): Promise<UsageSummary>`

- [ ] **Step 1: Write RED domain/repository tests**

Cover:
```ts
expect(creditsForUsage('asr_audio_seconds', 60).credits).toBe(10);
expect(creditsForUsage('translation_characters', 1000).credits).toBe(5);
expect(creditsForUsage('tts_characters', 1000).credits).toBe(20);
expect(creditsForUsage('render_seconds', 60).credits).toBe(2);
```

Repository tests must prove:
- a first idempotency-key insert returns `inserted: true`;
- replay of the same key returns the existing event and `inserted: false`;
- positive finite units are required;
- summary derives `allocatedCredits`, `usedCredits`, `remainingCredits`, `overageCredits`;
- totals/providers aggregate by kind/provider.

- [ ] **Step 2: Push test-only RED and verify the only new failures are missing usage modules/migration contracts**

Expected CI: existing suites PASS; new usage suite fails because implementation does not exist.

- [ ] **Step 3: Add migration**

```sql
ALTER TABLE usage_events ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE usage_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE usage_events ADD COLUMN credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_idempotency
  ON usage_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_user_provider_created
  ON usage_events(user_id, provider, created_at DESC);
```

- [ ] **Step 4: Implement domain rates and UsageRepository**

Use divisors: ASR 6 seconds/credit, translation 200 chars/credit, TTS 50 chars/credit, render 30 seconds/credit. Reject zero, negative, NaN, Infinity.

`record` uses `INSERT OR IGNORE` for an idempotency key, then reads the canonical row by key when ignored. `summaryForUser` reads allocated credits from `users.credit_balance` and aggregates usage rows by kind/provider.

- [ ] **Step 5: Run exact-head CI GREEN for Task 1**

Expected: all usage tests and existing suites PASS.

- [ ] **Step 6: Commit Task 1**

Commit message: `feat: add replay-safe usage ledger`

---

### Task 2: Usage Summary API and Retry Attempt Propagation

**Files:**
- Create: `worker/src/routes/usage.ts`
- Create: `worker/test/usage-route.test.ts`
- Modify: `worker/src/app.ts`
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/routes/jobs.ts`
- Modify: `worker/test/job-control-routes.test.ts`

**Interfaces:**
- `GET /api/usage/summary`
- `DubbingWorkflowParams.usageAttempt?: number`
- `ExportWorkflowParams.usageAttempt?: number`
- retry workflow params include `usageAttempt: job.retryCount`

- [ ] **Step 1: Add RED route/retry tests**

Route test asserts authorized current user summary JSON and `USAGE_SUMMARY_FAILED` on repository failure through dependency injection.

Retry test asserts:
```ts
expect(workflowCreates[0].params).toMatchObject({
  projectId: 'p1', userId: 'dev-user', jobId: 'j1', usageAttempt: 2,
});
```

- [ ] **Step 2: Verify RED**

Expected: summary route missing and retry params omit `usageAttempt`.

- [ ] **Step 3: Implement route and parameter propagation**

Mount `app.route('/api/usage', createUsageRoutes())`. Extend Workflow param types with optional attempt, preserving initial callers that omit it.

- [ ] **Step 4: Run GREEN**

Run full CI and ensure Phase 3A retry/cancel tests stay PASS.

- [ ] **Step 5: Commit Task 2**

Commit message: `feat: expose usage summary and retry attempts`

---

### Task 3: Dubbing Workflow ASR + Translation Metering

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`
- Modify: `worker/test/asr-router.test.ts` only if provider-label helper coverage is needed

**Interfaces:**
- `DubbingPipelineDeps.usage: Pick<UsageStore, 'record'>`
- `DubbingPipelineDeps.asrProvider: string`
- deterministic keys use `params.usageAttempt ?? 0`

- [ ] **Step 1: Add RED metering tests**

Prove:
- successful ASR chunk records `durationMs / 1000` with correct provider and key;
- successful translation batch records source character count with `workers-ai`;
- cancellation/provider failure before success records nothing;
- replay with the same attempt passes the exact same deterministic keys to UsageStore.

- [ ] **Step 2: Verify RED**

Expected: pipeline deps do not accept usage/asrProvider and no records occur.

- [ ] **Step 3: Implement metering**

DubbingWorkflow constructs `UsageRepository(this.env.DB)` and derives provider label from `asrCapabilities(this.env.DEEPGRAM_API_KEY).provider`.

Record inside separate `step.do` boundaries immediately after successful provider result and before progress advancement.

- [ ] **Step 4: Run GREEN**

Existing cancellation and ASR persistence tests must remain PASS.

- [ ] **Step 5: Commit Task 3**

Commit message: `feat: meter dubbing provider usage`

---

### Task 4: Export Workflow TTS + Render Metering

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/test/export-pipeline.test.ts`

**Interfaces:**
- `ExportPipelineDeps.usage: Pick<UsageStore, 'record'>`
- `ExportProject.durationMs?: number | null`

- [ ] **Step 1: Add RED tests**

Prove:
- a newly generated voice records `tts_characters` with provider `elevenlabs` and per-segment deterministic key;
- an already cached `dubbedObjectKey` does not record TTS usage;
- successful render records `render_seconds` with `ffmpeg-container`;
- missing/invalid project duration fails before render metering;
- same attempt produces stable keys.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement export metering**

ExportWorkflow injects UsageRepository. Include project duration in the export project read. Record TTS only after successful provider response + non-empty audio. Record render only after `renderExport` succeeds and its output key validates.

- [ ] **Step 4: Run GREEN**

Preserve speaker voice selection, cancellation, cached voice reuse, and export publishing tests.

- [ ] **Step 5: Commit Task 4**

Commit message: `feat: meter export provider usage`

---

### Task 5: Retranslation and Voice Preview Metering

**Files:**
- Modify: `worker/src/routes/translation.ts`
- Modify: `worker/test/translation-router.test.ts` or create `worker/test/translation-usage-route.test.ts`
- Modify: `worker/src/routes/voice.ts`
- Modify: `worker/test/voice-routes.test.ts`

**Interfaces:**
- translation route records source text length after provider success;
- compare mode records one event for `workers-ai` and one for `google`;
- voice preview records one `tts_characters` event for `elevenlabs` after successful audio generation;
- route factories accept optional dependency injection for UsageStore to make failure behavior testable.

- [ ] **Step 1: Add RED route tests**

Assert no usage writes on invalid JSON, invalid version, unconfigured provider, provider failure, or pre-provider version conflict.

Assert successful compare writes exactly two translation usage events.

Assert successful voice preview writes exactly one event; if usage persistence rejects after provider success, response is `500` with `USAGE_RECORD_FAILED` and no audio is returned.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement route metering and failure policy**

Do not change provider response semantics except the explicit metering persistence failure boundary.

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit Task 5**

Commit message: `feat: meter interactive provider usage`

---

### Task 6: Dashboard Credits and Provider Metrics

**Files:**
- Create: `src/features/usage/usageApi.ts`
- Create: `src/features/usage/usageApi.test.ts`
- Create: `src/features/usage/UsageSummaryCard.tsx`
- Create: `src/features/usage/UsageSummaryCard.test.tsx`
- Modify: `src/features/projects/ProjectDashboard.tsx`
- Modify: `src/features/projects/ProjectDashboard.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/AppDashboard.test.tsx`
- Modify: `src/styles/project-dashboard.css`

**Interfaces:**
- `getUsageSummary(): Promise<UsageSummary>`
- `ProjectDashboardProps.usage: UsageSummary | null`
- `ProjectDashboardProps.usageError: string`

- [ ] **Step 1: Add RED API/component/App tests**

Cover exact API path `/api/usage/summary`, remaining/overage labels, provider rows, and non-destructive usage error behavior.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement usage client/card and dashboard integration**

Load project snapshot and usage summary independently so usage failure does not hide projects. Use Vietnamese UI copy and no currency symbol.

- [ ] **Step 4: Run GREEN**

Reference UI tests and both desktop viewport source contracts must remain PASS.

- [ ] **Step 5: Commit Task 6**

Commit message: `feat: show credits and provider usage`

---

### Task 7: Phase 3B Acceptance Gate, Review, and Merge Qualification

**Files:**
- Create: `tests/phase3b-usage-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- `npm run verify:deploy-config` includes the Phase 3B acceptance source gate.

- [ ] **Step 1: Add RED acceptance test**

Lock source contracts for migration/idempotency, UsageRepository, workflow metering, summary route, dashboard usage card, and the unchanged manual-only/runtime-UNQUALIFIED boundary.

- [ ] **Step 2: Verify RED if any contract is missing; otherwise prove it catches one intentionally omitted wiring assertion before finalizing**

- [ ] **Step 3: Wire acceptance test into package verify and update deployment status**

Deployment status must say Phase 3B credits/provider-usage source is qualified only after exact-head GREEN; it must not claim live runtime usage evidence.

- [ ] **Step 4: Run full exact-head CI**

Required GREEN:
- deploy/source acceptance;
- all Vitest suites;
- TypeScript + Vite production build;
- Wrangler dry-run;
- CJK install;
- 1448x1086 + 1364x767 screenshots;
- artifact upload.

- [ ] **Step 5: Review PR diff and review threads**

Resolve regressions before Ready. Re-read live `main`; if it advanced, reconcile non-force and rerun exact-head CI.

- [ ] **Step 6: Merge with expected head SHA**

Use normal merge commit, never force.

- [ ] **Step 7: Verify fresh post-merge push CI on exact merge SHA**

Only then report Phase 3B source/CI complete. Production runtime remains UNQUALIFIED and no production deploy is triggered.

---

## Self-Review

- Spec coverage: ledger, rates, idempotency, retry attempt, dubbing/export/interactive metering, summary API, dashboard, CI boundary all mapped to tasks.
- Placeholder scan: no TBD/TODO implementation placeholders.
- Type consistency: `usageAttempt`, `UsageKind`, `UsageStore.record`, and `UsageSummary` names are consistent across tasks.
- Scope: Phase 3C/3D and payment/enforcement remain explicitly excluded.
