# YupVox Phase 3B Usage Ledger Design

Date: 2026-09-05
Status: Approved for implementation

## 1. Goal

Add a durable, idempotent internal usage ledger and provider-usage summary for YupVox without introducing payments, pricing enforcement, guessed provider rates, or credit depletion.

Phase 3B records normalized usage in stable base units so later quota, rate-limit, and cost-model decisions can be based on observed work rather than invented conversion rules.

## 2. Scope

Included:
- durable usage events for ASR, translation, TTS, and final render;
- deterministic idempotency across Cloudflare Workflow step retries/replay;
- explicit `started` and `completed` phases for externally dependent work;
- provider attribution per logical provider invocation;
- normalized base units: ASR seconds, translation characters, generated TTS audio seconds, and render seconds;
- authorized user/project usage summaries;
- a compact dashboard usage summary;
- internal credit balance readout only.

Deferred to later Phase 3 work:
- payment processor integration;
- decrementing, reserving, pricing, or enforcing credits;
- provider price tables or invoice reconciliation;
- hard quotas or rate limits;
- alerting/observability policy;
- public share links or download permissions.

## 3. Existing constraints

The existing `usage_events` table remains the source of truth for Phase 3B. Existing `users.credit_balance` remains unchanged and read-only in this phase. Existing Studio Pro V2.5 autosave/CAS behavior and Phase 3A durable job/retry/cancel behavior must not be weakened.

The current media adapter already exposes project-scoped `probe(...)` support through the FFmpeg Container. Phase 3B may use that capability to measure generated TTS artifact duration after the voice artifact is persisted; it must not invent TTS seconds from text length or scheduled segment span.

Production Cloudflare runtime qualification remains separate from source/CI qualification while the documented Containers credential and real-media fixture gates remain unresolved.

## 4. Usage event model

A usage event has:
- `id` — unique event ID;
- `user_id`;
- `project_id`;
- `job_id` when the event belongs to a durable job;
- `kind` — `asr_audio_second`, `translation_character`, `tts_audio_second`, or `render_second`;
- `units` — non-negative numeric usage quantity in that kind's canonical base unit;
- `provider` — provider identifier such as `deepgram`, `workers-ai`, `google`, `elevenlabs`, or `ffmpeg-container`;
- `phase` — `started` or `completed`;
- `operation_key` — deterministic idempotency key for one logical provider/render invocation within one durable job retry generation;
- `cost_basis` — `0` throughout Phase 3B;
- `created_at`.

`(operation_key, phase)` is unique. Re-executing the same Cloudflare Workflow step must not duplicate the same logical phase event.

Phase 3B is an operational usage ledger, not provider invoice reconciliation. A `started` event records that a logical external operation was attempted; a `completed` event records canonical successful work that YupVox can measure. If a provider was reached but the result was not durably completed, the ledger may retain `started` without fabricating completed usage.

## 5. Retry and idempotency semantics

Workflow step replay and explicit user job retry are different concepts.

For automatic/replayed execution within the same durable job retry generation, the operation key is stable and duplicate inserts are ignored/read back canonically.

For an explicit user retry, `jobs.retry_count` increments. The operation key includes that retry generation so genuinely repeated work is observable separately.

Canonical key shape:

`job:{jobId}:retry:{retryCount}:{stage}:{item}:{provider}`

Examples:
- `job:j1:retry:0:asr:chunk-0001:deepgram`;
- `job:j1:retry:0:translation:batch-0:workers-ai`;
- `job:j1:retry:0:translation:batch-0:google`;
- `job:j2:retry:1:tts:segment-s14:elevenlabs`;
- `job:j2:retry:1:render:final:ffmpeg-container`.

The provider suffix is part of the logical operation. Compare/quality translation modes that invoke more than one provider therefore meter each actual provider invocation independently.

## 6. Start/completion semantics

For externally dependent operations, write `started` immediately before the provider/container call and `completed` only after the result needed by YupVox is durably available and its measurable units are known.

This preserves two truths:
- successful canonical work has both phases;
- interrupted or ambiguous work can retain `started` without falsely claiming successful completion.

Completed usage summaries count only `phase='completed'`. Started-only rows remain available for later observability work but never inflate completed totals.

When final units are outcome-dependent, `started.units` may be `0`; the matching `completed` row carries the measured units. This specifically applies to TTS duration.

## 7. Metering rules

### ASR

One logical operation per extracted audio chunk and provider invocation.

- Kind: `asr_audio_second`.
- Completed units: `chunk.durationMs / 1000`.
- Started units may use the same known input duration.
- Provider: the actual configured ASR provider ID.
- Replaying the same chunk/provider operation in the same retry generation must not duplicate its ledger rows.

### Translation

One logical operation per translation batch per provider invocation.

- Kind: `translation_character`.
- Units: Unicode source-text character count sent to that provider invocation.
- Provider: the actual provider (`workers-ai`, `google`, etc.).
- Compare/quality modes that call more than one provider create distinct operation keys and rows for each invocation.
- Applying/rejecting a compare result later creates no extra usage event because the provider work already occurred.

### TTS

One logical operation per segment only when a new voice artifact is actually generated.

- Kind: `tts_audio_second`.
- Provider: the actual voice provider, currently `elevenlabs` for the production export path or `workers-ai` where that adapter is used.
- `started` is written before generation with `units = 0` because actual generated duration is not yet known.
- After non-empty generated audio is durably written to the project-scoped R2 key and the segment points at that artifact, use existing media `probe(objectKey)` to obtain `durationMs`.
- `completed.units = durationMs / 1000`.
- If a valid durable voice artifact is reused (`voiceStatus === 'completed'` with a durable dubbed object key), do not record a new TTS operation.
- If generation succeeds but later duration probe or ledger completion fails, retry/replay must reuse the durable artifact rather than intentionally regenerate voice merely to recover metering.

To distinguish a pre-existing artifact from current-generation incomplete metering, `UsageStore` exposes canonical lookup by `(operationKey, phase)`:
- if no current-generation `started` exists, treat the durable artifact as pre-existing and do not meter it;
- if current-generation `started` exists but `completed` does not, probe the durable artifact and complete usage without regenerating voice.

### Render

One logical operation for final dubbed-media render.

- Kind: `render_second`.
- Provider: `ffmpeg-container`.
- Units: durable project `durationMs / 1000`.
- Duration must come from canonical project metadata established by media probing; do not infer it from segment count or subtitle span.
- `started` is written immediately before final render and `completed` only after a valid project-scoped final export artifact is durably available.

## 8. Database migration

Add nullable/backfill-safe columns to `usage_events`:
- `job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`;
- `phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'))`;
- `operation_key TEXT`.

Add a partial unique index for new metered events:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_operation_phase
  ON usage_events(operation_key, phase)
  WHERE operation_key IS NOT NULL;
```

Existing historical rows remain valid completed usage and require no synthetic operation keys. Existing historical `kind` values, if any, remain historical data; Phase 3B writers use only the normalized kinds defined above.

No pricing columns or credit-debit ledger are added in Phase 3B.

## 9. Repository boundary

Create/maintain `worker/src/db/usage.ts` with `UsageStore` and `UsageRepository`.

Required methods:
- `record(input: UsageRecordInput): Promise<UsageEvent>` — insert-or-read canonical event by `(operationKey, phase)`;
- `getByOperation(operationKey: string, phase: UsagePhase): Promise<UsageEvent | null>`;
- `summarizeForUser(userId: string): Promise<UsageSummary>`;
- `summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>`;
- `getCreditBalance(userId: string): Promise<number>`.

Canonical summary totals:

```ts
{
  asrAudioSeconds: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  renderSeconds: number;
}
```

`record` validates non-negative finite units, non-empty server-generated operation keys/provider IDs, supported phases, and normalized Phase 3B kinds before writing.

Summary totals include only `phase='completed'` rows, preserve provider breakdown, and never round stored values. Project summaries fail closed with `PROJECT_NOT_FOUND` when ownership does not match.

## 10. Workflow integration

`DubbingWorkflow` and `ExportWorkflow` construct `UsageRepository` and inject a narrow usage interface into the pipeline layer rather than exposing D1 directly to provider adapters.

The retry generation used in operation keys comes from the canonical durable job row. Pipelines must not infer retry count from local loop state.

Metering is placed at durable boundaries around provider/container work:
- record `started` before the logical external call;
- perform provider/container work in the existing deterministic Workflow structure;
- persist the durable result/artifact;
- record `completed` with measured units.

Automatic Workflow replay reuses the same operation key. Existing durable outputs are checked/reused before new external work where a valid reusable-artifact contract exists.

Usage recording failures are not silently swallowed. However, implementation must avoid intentionally repeating already-durable TTS generation merely because a later usage-duration probe or ledger write failed.

## 11. API

Add authorized routes:
- `GET /api/usage` — current user's completed usage summary plus informational credit balance;
- `GET /api/projects/:id/usage` — completed usage summary scoped to a project owned by the current user.

Cross-user project access returns 404 rather than exposing resource existence. No route accepts arbitrary `userId` from the client.

User-level response:

```ts
{
  creditBalance: number,
  totals: {
    asrAudioSeconds: number,
    translationCharacters: number,
    ttsAudioSeconds: number,
    renderSeconds: number
  },
  providers: Record<string, {
    asrAudioSeconds: number,
    translationCharacters: number,
    ttsAudioSeconds: number,
    renderSeconds: number
  }>
}
```

Project response uses the same `totals`/`providers` shape and may omit `creditBalance`.

## 12. Dashboard UX

The Phase 3A dashboard receives a compact independent usage summary panel displaying:
- available internal credits as informational only;
- completed ASR time;
- translation characters;
- completed generated voice time;
- completed render time;
- provider breakdown in a secondary region.

The API remains normalized in seconds. UI may present seconds or convert to minutes depending on magnitude, but presentation conversion must not alter canonical stored/returned units.

No payment CTA, upgrade prompt, quota warning, or fake monetary estimate is introduced in Phase 3B.

A usage API failure does not hide persisted projects/jobs. Usage loading/error state is independent.

## 13. Precision

Usage units remain numeric/REAL as already supported by schema. Repository/API summaries accumulate without early rounding.

UI only rounds for presentation:
- time: at most two decimals after chosen display-unit conversion;
- characters: integer locale formatting.

Tests use values that expose precision mistakes.

## 14. Security

All usage queries are scoped to the current user. Project summaries require ownership. No route accepts arbitrary user identity from request data.

Operation keys are server-generated and never trusted from request bodies.

## 15. Required tests

- migration keeps existing rows valid and enforces unique `(operation_key, phase)` for new rows;
- duplicate same-operation insert returns canonical single event;
- started and completed phases coexist;
- canonical lookup works;
- summaries exclude started-only rows;
- provider totals and aggregate totals retain precision;
- cross-user project usage is hidden/fails closed;
- ASR chunk replay does not double-count and explicit job retry gets a distinct key;
- ASR uses seconds;
- translation usage follows actual provider invocation/input;
- reused durable TTS output writes no new usage;
- current-generation started-but-incomplete TTS reuses/probes durable artifact without regeneration;
- newly generated TTS usage uses probed generated-audio seconds;
- render uses durable project seconds;
- usage API authorization and error redaction;
- dashboard usage failure is isolated from project/job state;
- no Phase 3B path decrements credits;
- source acceptance rejects stale `asr_audio_minute`, `tts_character`, or `render_minute` contracts.

## 16. Qualification

Each implementation task follows RED -> GREEN. Before merge:
1. run the repository's full verification contract;
2. require exact-head GitHub Actions GREEN including Wrangler dry-run and screenshot/artifact gates;
3. re-read live `main` and reverse-sync non-force if it advanced;
4. rerun full exact-head CI after reconciliation;
5. merge with expected head SHA;
6. require post-merge `main` CI GREEN.

Production runtime remains UNQUALIFIED unless separate live Cloudflare credentials/runtime gates pass.
