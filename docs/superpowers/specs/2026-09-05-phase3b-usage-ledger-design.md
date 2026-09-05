# YupVox Phase 3B Usage Ledger Design

Date: 2026-09-05
Status: Approved for implementation

## 1. Goal
Add a durable, idempotent internal usage ledger and provider-usage summary for YupVox without introducing payments, pricing enforcement, or guessed provider rates.

Phase 3B measures billable work accurately so later Phase 3C quota/rate-limit decisions can be based on observed usage rather than invented credit conversion rules.

## 2. Scope

Included:
- durable usage events for ASR, translation, TTS, and final render;
- deterministic idempotency across Cloudflare Workflow step retries;
- explicit start/completion phases for externally billable provider calls;
- provider attribution where the runtime result exposes it;
- authorized user/project usage summaries;
- dashboard usage summary UI;
- internal credit balance readout only.

Deferred:
- payment processor integration;
- decrementing or reserving credits;
- cost/rate tables;
- hard quotas or rate limits;
- alerting/observability policy;
- public share links/download permissions.

## 3. Existing constraints

The existing `usage_events` table is the source of truth for Phase 3B. Existing `users.credit_balance` remains unchanged and read-only for this phase. Existing Studio Pro V2.5 autosave/CAS behavior and Phase 3A durable job behavior must not be weakened.

Production Cloudflare runtime qualification remains separate from source/CI qualification while the documented Containers credential blocker exists.

## 4. Usage model

A usage event has:
- `id` — unique event ID;
- `user_id`;
- `project_id`;
- `job_id` when the event belongs to a durable job;
- `kind` — `asr_audio_minute`, `translation_character`, `tts_character`, or `render_minute`;
- `units` — non-negative numeric usage quantity;
- `provider` — provider identifier such as `deepgram`, `workers-ai`, `google`, `elevenlabs`, or `ffmpeg-container`;
- `phase` — `started` or `completed`;
- `operation_key` — deterministic idempotency key for one logical provider/render operation within one job retry generation;
- `cost_basis` — `0` in Phase 3B;
- `created_at`.

`operation_key + phase` is unique. Re-executing the same Cloudflare Workflow step must therefore not duplicate the same phase event.

## 5. Retry and idempotency semantics

Workflow step retry and explicit user job retry are different concepts.

For automatic/replayed execution within the same durable job generation, the operation key is stable and duplicate inserts are ignored.

For an explicit user retry, `jobs.retry_count` increments. The usage key includes that retry generation, so genuinely repeated provider work can be observed independently.

Canonical key shape:

`job:{jobId}:retry:{retryCount}:{stage}:{item}`

Examples:
- `job:j1:retry:0:asr:chunk-0001`
- `job:j1:retry:0:translation:batch-0`
- `job:j2:retry:1:tts:segment-s14`
- `job:j2:retry:1:render:final`

## 6. Start/completion semantics

For external provider operations, write `started` immediately before the provider call and `completed` only after success.

This preserves two useful truths:
- successful calls have both phases;
- interrupted/ambiguous calls can retain `started` without falsely claiming successful completion.

The UI summary counts completed units by default. Started-only events remain queryable for future observability work but do not inflate completed usage totals.

## 7. Metering rules

### ASR
One logical operation per extracted audio chunk. Units are `chunk.durationMs / 60000`. Provider is the actual ASR provider identifier when available from the configured adapter; otherwise use the adapter's stable configured provider ID.

### Translation
One logical operation per translation batch. Units are total Unicode source-text character count for the batch. Provider for the completed event comes from the translation results. A batch with mixed provider values is split into provider-specific completed usage rows while preserving the same stage/batch lineage in the operation key suffix.

### TTS
One logical operation per segment only when a new voice artifact is actually generated. Units are Unicode character count of trimmed translated text. Provider is `elevenlabs` for the existing production adapter. If `voiceStatus === 'completed'` and a durable dubbed object key is reused, no new TTS usage event is written.

### Render
One logical operation for final render. Units are project duration in minutes. Provider is `ffmpeg-container`. Duration comes from durable project metadata; the export pipeline must not guess from segment count.

## 8. Database migration

Add nullable/backfill-safe columns to `usage_events`:
- `job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`;
- `phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'))`;
- `operation_key TEXT`.

Add a partial unique index for new metered events:

`CREATE UNIQUE INDEX ... ON usage_events(operation_key, phase) WHERE operation_key IS NOT NULL;`

Existing rows remain valid historical completed usage and do not require synthetic operation keys.

## 9. Repository boundary

Create `worker/src/db/usage.ts` with `UsageStore` and `UsageRepository`.

Required methods:
- `record(input: UsageRecordInput): Promise<UsageEvent>` — insert-or-read canonical event by `(operationKey, phase)`;
- `summarizeForUser(userId: string): Promise<UsageSummary>`;
- `summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>`;
- `getCreditBalance(userId: string): Promise<number>`.

Summary totals include only `phase='completed'` rows and preserve provider breakdown.

## 10. Workflow integration

`DubbingWorkflow` and `ExportWorkflow` construct a `UsageRepository` and inject it into their pipelines.

The pipeline layer receives a narrow usage interface rather than a concrete D1 repository.

The job retry generation used in operation keys comes from the canonical job row. Pipelines must not infer retry count from local loop state.

Provider calls and usage recording remain inside deterministic Workflow steps so automatic step replays preserve operation keys.

## 11. API

Add authorized routes:
- `GET /api/usage` — current user's completed usage summary + current credit balance;
- `GET /api/projects/:id/usage` — current user's completed usage summary scoped to an owned project.

Cross-user project access returns 404 rather than exposing resource existence.

Response shape:

```ts
{
  creditBalance: number,
  totals: {
    asrAudioMinutes: number,
    translationCharacters: number,
    ttsCharacters: number,
    renderMinutes: number
  },
  providers: Record<string, {
    asrAudioMinutes: number,
    translationCharacters: number,
    ttsCharacters: number,
    renderMinutes: number
  }>
}
```

Project response may omit `creditBalance`; user-level response includes it.

## 12. Dashboard UX

The Phase 3A dashboard gets a compact usage summary panel. It displays:
- available internal credits as an informational number only;
- completed ASR minutes;
- translation characters;
- TTS characters;
- render minutes;
- provider breakdown in a secondary details region.

No payment CTA, upgrade prompt, or quota warning is introduced in Phase 3B.

A usage API failure does not hide persisted projects/jobs. The dashboard keeps the last canonical project/job state and surfaces usage loading/error independently.

## 13. Precision

Usage units are stored as REAL where already supported by schema. Repository summaries use numeric accumulation without early display rounding. UI rounds only for presentation:
- minutes: two decimal places;
- character counts: integer formatting.

Tests use values that expose precision mistakes.

## 14. Security

All usage queries are scoped to the current user. Project summaries require project ownership. No route accepts arbitrary `userId` from the client.

Operation keys are server-generated and never trusted from request bodies.

## 15. Testing

Required tests:
- migration keeps existing rows valid and enforces unique `(operation_key, phase)` for new rows;
- repository duplicate same-operation insert returns canonical single event;
- started and completed phases can coexist for one operation;
- summaries exclude started-only events;
- provider totals and aggregate totals retain precision;
- cross-user project usage is hidden;
- ASR chunk retries do not double-count completed usage;
- explicit durable job retry generation gets a distinct operation key;
- translation completed usage follows provider result;
- reused durable TTS output writes no new usage;
- render uses durable project duration;
- dashboard usage failure is isolated from project/job state.

## 16. Qualification

Each implementation task follows RED -> GREEN. Before merge:
1. run the repository's full verification contract;
2. require exact-head GitHub Actions GREEN including Wrangler dry-run and screenshot/artifact gates;
3. re-read live `main` and reverse-sync if it advanced;
4. rerun full exact-head CI after reconciliation;
5. merge with expected head SHA;
6. require post-merge `main` CI GREEN.

Production runtime remains UNQUALIFIED unless separate live Cloudflare credentials/runtime gates pass.
