# Phase 3B Usage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, idempotent usage metering and authorized usage summaries for ASR, translation, TTS, and render without pricing enforcement or payments.

**Architecture:** Extend D1 `usage_events` with deterministic operation identity and `started|completed` phases. A focused `UsageRepository` is injected into dubbing/export workflows through narrow interfaces; API/UI consume completed summaries only. TTS completion uses the measured duration of the durable generated artifact and can recover from a post-generation probe/ledger failure without regenerating voice.

**Tech Stack:** React 19 + TypeScript + Vite, Hono Worker API, Cloudflare D1, Cloudflare Workflows, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-phase3b-usage-ledger-design.md`

## Global Constraints

- Master-design units are exactly: ASR audio **minutes**, translation **characters**, generated TTS audio **seconds**, render **minutes**.
- `cost_basis` stays `0` in Phase 3B.
- `users.credit_balance` is read-only; do not decrement, reserve, price, or enforce credits.
- Automatic Workflow replay must not duplicate `(operation_key, phase)`.
- Explicit user retry uses durable `jobs.retry_count` and therefore a distinct operation generation.
- Completed summaries exclude started-only events.
- Pre-existing durable TTS output is not newly metered.
- A current-generation TTS operation with `started` but no `completed` must reuse/probe its durable artifact rather than regenerate voice.
- Studio Pro V2.5 CAS/autosave and Phase 3A job semantics remain unchanged.
- Production runtime qualification remains separate from source/CI qualification.

---

### Task 1: Idempotent Usage Schema and Repository

**Files:**
- Create: `migrations/0005_usage_event_idempotency.sql`
- Create: `worker/src/db/usage.ts`
- Create/modify: `worker/test/usage.test.ts`

**Produces:**
```ts
type UsageKind = 'asr_audio_minute' | 'translation_character' | 'tts_audio_second' | 'render_minute';
type UsagePhase = 'started' | 'completed';
type UsageTotals = {
  asrAudioMinutes: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  renderMinutes: number;
};
interface UsageStore {
  record(input: UsageRecordInput): Promise<UsageEvent>;
  getByOperation(operationKey: string, phase: UsagePhase): Promise<UsageEvent | null>;
  summarizeForUser(userId: string): Promise<UsageSummary>;
  summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>;
  getCreditBalance(userId: string): Promise<number>;
}
```

- [x] Write RED repository tests and verify the only new failure is missing `db/usage`.
- [x] Add migration columns `job_id`, `phase`, `operation_key` and partial unique index on `(operation_key, phase)`.
- [ ] Update repository/test to `tts_audio_second` + `ttsAudioSeconds` and add canonical `getByOperation` coverage.
- [ ] Run `npx vitest run worker/test/usage.test.ts`; expect PASS.
- [ ] Run `npm run verify`; expect PASS before starting Task 2.

---

### Task 2: Meter Dubbing ASR and Translation

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`

**Interfaces:** `PipelineJobs` gains `getForProject`; deps gain `usage: Pick<UsageStore,'record'>` and `asrProviderId` from `asrCapabilities(...)`.

- [ ] RED: for a 90,000 ms chunk assert ASR started/completed events have `kind:'asr_audio_minute'`, `units:1.5`, provider-qualified key `job:j1:retry:0:asr:<item>:<provider>`; retryCount 1 must change the key.
- [ ] RED: translation batch usage is Unicode source-character count and completed provider comes from real result provider. Current direct Workers-AI workflow must meter `workers-ai`, not a synthetic billing provider.
- [ ] Implement canonical job read for `retryCount`, ASR events around `transcribe`, translation events around current provider invocation/result.
- [ ] Wire `UsageRepository` + `asrCapabilities(...).provider` in `DubbingWorkflow`.
- [ ] Run focused tests then `npm run verify`; expect PASS.

---

### Task 3: Meter TTS Generated Duration and Final Render

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/test/export-pipeline.test.ts`

**Interfaces:** export project includes `durationMs`; jobs gain `getForProject`; deps gain `usage: Pick<UsageStore,'record'|'getByOperation'>`; media gains `probe` alongside `renderExport`.

- [ ] RED: newly generated TTS records `started` with `units:0`, persists audio/segment, probes durable artifact, then records `completed` `tts_audio_second` with measured `durationMs/1000`.
- [ ] RED: a pre-existing durable voice artifact with no current-generation `started` event writes no TTS usage.
- [ ] RED: durable voice + current-generation `started` but no `completed` probes and completes usage without calling `voice.generate`.
- [ ] RED: render uses canonical `project.durationMs/60000`, provider `ffmpeg-container`, and provider-qualified operation key.
- [ ] Implement and wire `UsageRepository` in `ExportWorkflow`.
- [ ] Run focused tests then `npm run verify`; expect PASS.

---

### Task 4: Authorized Usage Summary API

**Files:**
- Create: `worker/src/routes/usage.ts`
- Create: `worker/test/usage-routes.test.ts`
- Modify: `worker/src/app.ts`

- [ ] RED: `GET /api/usage` returns completed summary + informational credit balance; `GET /api/projects/:id/usage` returns owned-project summary; cross-user/missing project maps to 404.
- [ ] Implement routes using only `getCurrentUserId()`, never request-supplied user IDs.
- [ ] Generic internal errors return structured 500 without SQL/detail leakage.
- [ ] Mount under `/api`; run focused tests + `npm run verify`; expect PASS.

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

- [ ] RED: API requests `/api/usage`; panel renders credits, ASR minutes, translation characters, TTS audio seconds, render minutes and provider breakdown.
- [ ] Implement display-only rounding (time max 2 decimals; characters integers); never mutate canonical totals.
- [ ] Load usage independently from project/job snapshot so usage failure leaves projects/jobs visible.
- [ ] Run focused frontend tests + `npm run verify`; expect PASS.

---

### Task 6: Exact-Head Qualification and Merge

- [ ] Run full `npm run verify`.
- [ ] Open Draft PR from exact carrier head and state explicit deferrals: pricing/credit enforcement, rate limits, observability policy, sharing.
- [ ] Require exact-head CI GREEN: source/tests/build, Wrangler dry-run, CJK setup, both reference screenshots, artifact upload.
- [ ] Re-read live `main`; if advanced, reverse-sync non-force/contract-aware and rerun exact-head full CI.
- [ ] Mark ready only after current exact head is FULL GREEN.
- [ ] Merge with `expected_head_sha` using a merge commit.
- [ ] Verify `main` points to merge commit and require post-merge main CI FULL GREEN.
- [ ] Keep production runtime UNQUALIFIED unless separate live Cloudflare credential/real-media gates pass.
