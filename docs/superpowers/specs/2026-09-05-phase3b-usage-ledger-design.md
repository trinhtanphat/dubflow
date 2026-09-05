# YupVox Phase 3B Usage Ledger Design

Date: 2026-09-05
Status: Pending user review

## 1. Goal
Add a durable, idempotent internal usage ledger and provider-usage summary for YupVox without introducing payments, pricing enforcement, guessed provider rates, or credit depletion.

Phase 3B records normalized usage in stable base units so later quota, rate-limit, and cost-model decisions can be based on observed work rather than invented conversion rules.

## 2. Scope

Included:
- durable usage events for ASR, translation, TTS, and final render;
- deterministic idempotency across Cloudflare Workflow step retries;
- explicit `started` and `completed` phases for externally dependent work;
- provider attribution per logical provider invocation;
- normalized base units: ASR seconds, translation characters, generated TTS audio seconds, and render seconds;
- authorized user/project usage summaries;
- a compact dashboard usage summary;
- internal credit balance readout only.

Deferred to later Phase 3 work:
- payment processor integration;
- decrementing, reserving, or pricing credits;
- provider price tables or invoice reconciliation;
- hard quotas or rate limits;
- alerting/observability policy;
- public share links or download permissions.

## 3. Existing constraints

The existing `usage_events` table remains the source of truth for Phase 3B. Existing `users.credit_balance` remains unchanged and read-only in this phase. Existing Studio Pro V2.5 autosave/CAS behavior and Phase 3A durable job behavior must not be weakened.

The current media adapter already exposes durable project-scoped `probe(...)` support through the FFmpeg Container. Phase 3B may use that existing capability to measure generated TTS artifact duration after the voice artifact is persisted; it must not invent TTS seconds from text length or scheduled segment span.

Production Cloudflare runtime qualification remains separate from source/CI qualification while the documented Containers credential blocker exists.

## 4. Usage event model

A usage event has:
- `id` — unique event ID;
- `user_id`;
- `project_id`;
- `job_id` when the event belongs to a durable job;
- `kind` — `asr_audio_second`, `translation_character`, `tts_audio_second`, or `render_second`;
- `units` — non-negative numeric usage quantity in the kind's base unit;
- `provider` — provider identifier such as `deepgram`, `workers-ai`, `google`, `elevenlabs`, or `ffmpeg-container`;
- `phase` — `started` or `completed`;
- `operation_key` — deterministic idempotency key for one logical provider/render invocation within one durable job retry generation;
- `cost_basis` — `0` throughout Phase 3B;
- `created_at`.

`operation_key + phase` is unique. Re-executing the same Cloudflare Workflow step must not duplicate the same logical phase event.

Phase 3B is an operational usage ledger, not provider invoice reconciliation. A `started` event records that a logical external operation was attempted; a `completed` event records canonical successful work that YupVox can measure. If a provider was reached but the result was not durably completed, the ledger may retain `started` without fabricating completed usage.

## 5. Retry and idempotency semantics

Workflow step replay and explicit user job retry are different concepts.

For automatic/replayed execution within the same durable job retry generation, the operation key is stable and duplicate inserts are ignored/read back canonically.

For an explicit user retry, `jobs.retry_count` increments. The operation key includes that retry generation so genuinely repeated work is observable separately.

Canonical key shape:

`job:{jobId}:retry:{retryCount}:{stage}:{item}:{provider}`

Examples:
- `job:j1:retry:0:asr:chunk-0001:deepgram`
- `job:j1:retry:0:translation:batch-0:workers-ai`
- `job:j1:retry:0:translation:batch-0:google`
- `job:j2:retry:1:tts:segment-s14:elevenlabs`
- `job:j2:retry:1:render:final:ffmpeg-container`

The provider suffix is part of the logical operation. Compare/quality translation modes that invoke more than one provider therefore meter each actual provider invocation independently instead of trying to split one ambiguous event after the fact.

## 6. Start/completion semantics

For an externally dependent operation, write `started` immediately before the provider/container call and `completed` only after the result needed by YupVox is durably available and its measurable units are known.

This preserves two truths:
- successful canonical work has both phases;
- interrupted or ambiguous work can retain `started` without falsely claiming successful completion.

Completed usage summaries count only `phase='completed'`. Started-only rows remain available for later observability work but never inflate completed totals.

When the final units are outcome-dependent, a `started` row may use `units = 0`; the corresponding `completed` row carries the measured units. This specifically applies to TTS duration, which is not known until the generated audio artifact can be probed.

## 7. Metering rules

### ASR
One logical operation per extracted audio chunk and provider invocation.

- Kind: `asr_audio_second`.
- Completed units: `chunk.durationMs / 1000`.
- Started units may use the same known input duration.
- Provider: the actual configured ASR provider (`deepgram` or `workers-ai`).
- Replaying the same chunk/provider operation in the same retry generation must not duplicate its ledger rows.

### Translation
One logical operation per translation batch per provider invocation.

- Kind: `translation_character`.
- Units: Unicode source-text character count sent to that provider invocation.
- Provider: the actual provider (`workers-ai` or `google`).
- Compare/quality modes that call both providers create distinct operation keys and distinct usage rows for each provider invocation.
- Applying or rejecting a compare result later does not create another translation usage event because the provider work already occurred.

### TTS
One logical operation per segment only when a new voice artifact is actually generated.

- Kind: `tts_audio_second`.
- Provider: the actual voice provider, currently `elevenlabs` for the production export path or `workers-ai` where that adapter is used.
- `started` is written before generation with `units = 0` because actual generated duration is unknown.
- After the non-empty generated audio is durably written to the project-scoped R2 key and the segment points at that artifact, use the existing media `probe(objectKey)` capability to obtain `durationMs`.
- `completed` units are `durationMs / 1000`.
- If a valid durable voice artifact is reused (`voiceStatus === 'completed'` with a durable dubbed object key), do not record a new TTS operation.
- If the generation succeeds but the later duration probe fails, retry/replay must reuse the durable artifact rather than intentionally regenerate voice merely to obtain usage duration.

### Render
One logical operation for the final dubbed-media render.

- Kind: `render_second`.
- Provider: `ffmpeg-container`.
- Units: durable project `durationMs / 1000`.
- Duration must come from canonical project metadata established by media probing; the export pipeline must not infer it from segment count or subtitle span.
- `started` is written immediately before final render and `completed` only after the final export artifact is durably available with a valid project-scoped export key.

## 8. Database migration

Add nullable/backfill-safe columns to `usage_events`:
- `job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`;
- `phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'))`;
- `operation_key TEXT`.

Add a partial unique index for new metered events:

`CREATE UNIQUE INDEX ... ON usage_events(operation_key, phase) WHERE operation_key IS NOT NULL;`

Existing historical rows remain valid completed usage and do not require synthetic operation keys. Existing `kind` values, if any, are preserved as historical data; Phase 3B writers use only the normalized kinds defined in this spec.

No pricing columns or credit-debit ledger are added in Phase 3B.

## 9. Repository boundary

Create `worker/src/db/usage.ts` with `UsageStore` and `UsageRepository`.

Required methods:
- `record(input: UsageRecordInput): Promise<UsageEvent>` — insert-or-read the canonical event by `(operationKey, phase)`;
- `summarizeForUser(userId: string): Promise<UsageSummary>`;
- `summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>`;
- `getCreditBalance(userId: string): Promise<number>`.

`record` validates non-negative finite units, non-empty server-generated operation keys, supported phases, and normalized Phase 3B kinds before writing.

Summary totals include only `phase='completed'` rows and preserve provider breakdown. Summary queries must not round stored values.

## 10. Workflow integration

`DubbingWorkflow` and `ExportWorkflow` construct a `UsageRepository` and inject a narrow usage interface into the pipeline layer rather than exposing D1 directly to provider adapters.

The retry generation used in operation keys comes from the canonical durable job row. Pipelines must not infer retry count from local loop state.

Metering is placed at durable boundaries around provider/container calls:
- record `started` before the logical call;
- perform provider/container work in the existing Workflow step structure;
- persist the durable result/artifact;
- record `completed` with measured units.

Automatic Workflow replay must reuse the same operation key. Existing durable outputs are checked/reused before new external work where the pipeline already has a valid reusable artifact contract.

Usage recording failures are not silently swallowed. A provider result must not be reported as fully metered/qualified if its required completed usage event could not be durably recorded; however, the implementation must avoid intentionally repeating already-durable TTS generation merely because a later usage-duration probe or ledger write failed.

## 11. API

Add authorized routes:
- `GET /api/usage` — current user's completed usage summary plus current informational credit balance;
- `GET /api/projects/:id/usage` — completed usage summary scoped to a project owned by the current user.

Cross-user project access returns 404 rather than exposing resource existence. No route accepts arbitrary `userId` from the client.

User-level response shape:

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

Project response uses the same `totals` and `providers` shape and may omit `creditBalance`.

## 12. Dashboard UX

The Phase 3A dashboard gets a compact usage summary panel. It displays:
- available internal credits as an informational number only;
- completed ASR time;
- translation characters;
- completed generated voice time;
- completed render time;
- provider breakdown in a secondary details region.

The API remains normalized in seconds; the UI may present time values as seconds or minutes depending on magnitude. Presentation conversion must not alter canonical stored/returned base units.

No payment CTA, upgrade prompt, quota warning, or fake monetary estimate is introduced in Phase 3B.

A usage API failure does not hide persisted projects/jobs. The dashboard keeps canonical project/job state visible and surfaces usage loading/error independently.

## 13. Precision

Usage units are stored as `REAL` where already supported by schema. Repository summaries use numeric accumulation without early display rounding.

UI presentation rules:
- time values may be converted from seconds to minutes only for display and rounded to at most two decimal places;
- character counts are displayed as integers;
- provider and aggregate totals are derived from the same completed rows and must reconcile within floating-point test tolerance.

Tests use fractional-second values that expose accidental minute conversion or early rounding mistakes.

## 14. Security and trust boundaries

All usage queries are scoped to the authenticated/current user. Project summaries require project ownership.

Operation keys are server-generated and never trusted from request bodies. Provider identifiers are derived from configured adapters/runtime results, not client input.

Usage APIs expose operational quantities and provider names only; they do not expose secret values, provider credentials, internal request payloads, or arbitrary cross-user identifiers.

## 15. Testing

Required tests include:
- migration keeps existing rows valid and enforces unique `(operation_key, phase)` for new rows;
- repository duplicate same-operation insert returns one canonical event;
- `started` and `completed` phases can coexist for one operation;
- summaries exclude started-only events;
- normalized kinds use seconds/characters exactly as specified;
- provider totals and aggregate totals retain precision;
- cross-user project usage is hidden;
- ASR chunk Workflow replay does not double-count completed usage;
- explicit durable job retry generation gets a distinct operation key;
- compare/quality translation provider invocations meter independently;
- reused durable TTS output writes no new TTS usage;
- new TTS output is probed and completed usage uses measured generated-audio seconds;
- a TTS duration-probe retry reuses the durable voice artifact rather than intentionally regenerating it;
- render usage uses durable project duration seconds;
- usage API authorization and response shapes are stable;
- dashboard usage failure is isolated from project/job state;
- credit balance is read-only and no Phase 3B path decrements or reserves it.

## 16. Qualification

Each implementation task follows RED -> GREEN. Before merge:
1. run the repository's full verification contract;
2. require exact-head GitHub Actions GREEN including Wrangler dry-run and screenshot/artifact gates;
3. re-read live `main` and reverse-sync/reconcile without force if `main` advanced;
4. rerun full exact-head CI after reconciliation;
5. merge only from the exact qualified head SHA;
6. require post-merge `main` CI GREEN.

Source/CI qualification does not imply production runtime qualification. Production runtime remains UNQUALIFIED unless the separate Cloudflare credential and real-media fixture gates pass.

## 17. Explicit non-goals

Phase 3B does not:
- define a monetary value for credits;
- charge or reserve credits;
- enforce user quotas;
- implement billing or checkout;
- estimate provider invoices;
- add general observability/alerting;
- implement rate limits;
- implement public sharing/download ACLs;
- claim production-runtime usage accuracy before live credentials and real-media qualification exist.
