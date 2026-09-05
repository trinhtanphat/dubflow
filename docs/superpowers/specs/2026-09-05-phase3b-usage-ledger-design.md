# YupVox Phase 3B Usage Ledger Design

Date: 2026-09-05
Status: Approved for implementation — reconciled to master design

## 1. Goal
Add a durable, idempotent internal usage ledger and provider-usage summary without payments, pricing enforcement, guessed provider rates, or credit depletion.

Phase 3B records operational usage so later quota/rate-limit/cost decisions can be based on measured work.

## 2. Scope

Included:
- durable usage events for ASR, translation, TTS, and final render;
- deterministic idempotency across Workflow step replay;
- `started` and `completed` phases;
- provider attribution per logical provider invocation;
- master-design units: **ASR audio minutes, translation characters, TTS generated-audio seconds, render minutes**;
- authorized user/project summaries;
- dashboard usage summary;
- informational read-only credit balance.

Deferred:
- payment integration;
- decrementing/reserving/pricing credits;
- provider price tables/invoice reconciliation;
- hard quotas/rate limits;
- general observability/alerting policy;
- public share/download ACLs.

## 3. Existing constraints

`usage_events` remains the Phase 3B source of truth. `users.credit_balance` is read-only. Studio Pro V2.5 CAS/autosave and Phase 3A durable job semantics must remain unchanged.

Production runtime qualification remains separate while Cloudflare Containers credentials/live real-media gates are unresolved.

## 4. Event model

Each event has `id`, `user_id`, `project_id`, `job_id`, `kind`, `units`, `provider`, `phase`, `operation_key`, `cost_basis`, and `created_at`.

Phase 3B kinds:
- `asr_audio_minute`;
- `translation_character`;
- `tts_audio_second`;
- `render_minute`.

`cost_basis` is always `0` in Phase 3B.

`(operation_key, phase)` is unique. Automatic replay of the same logical operation reads the canonical existing event instead of duplicating it.

## 5. Operation identity

Workflow replay and explicit user retry are different.

Canonical key:

`job:{jobId}:retry:{retryCount}:{stage}:{item}:{provider}`

Examples:
- `job:j1:retry:0:asr:chunk-0001:deepgram-nova-3`
- `job:j1:retry:0:translation:batch-0:workers-ai`
- `job:j2:retry:1:tts:segment-s14:elevenlabs`
- `job:j2:retry:1:render:final:ffmpeg-container`

`retry_count` comes from the canonical durable job row. Local loop state must never substitute for it.

## 6. Start/completion semantics

Write `started` immediately before the logical external/provider/container call. Write `completed` only after the result needed by YupVox is durably available and measurable.

Completed summaries count only `phase='completed'`.

If final units are outcome-dependent, `started.units` may be `0`; `completed.units` carries the measured quantity. This is required for TTS generated-audio duration.

## 7. Metering rules

### ASR
- one operation per extracted chunk/provider invocation;
- kind `asr_audio_minute`;
- units `chunk.durationMs / 60000`;
- provider is the configured adapter ID from `asrCapabilities(...)`;
- same job generation + same chunk/provider is idempotent.

### Translation
- one operation per batch/provider invocation;
- kind `translation_character`;
- units are Unicode source-text characters sent to that provider;
- provider is the real translation provider (`workers-ai`, `google`, etc.);
- compare/quality modes meter each actual provider invocation independently.

### TTS
- one operation per segment only when a new voice artifact is generated;
- kind `tts_audio_second`;
- provider is the actual voice provider, currently `elevenlabs` on export;
- `started.units = 0` before generation;
- after non-empty audio is durably written and the segment references it, probe the durable object with the existing media processor;
- `completed.units = generatedDurationMs / 1000`;
- a pre-existing valid durable voice artifact produces no new TTS operation.

To avoid regenerating voice when generation succeeded but later probe/ledger completion failed, `UsageStore` exposes canonical lookup by `(operationKey, phase)`. On a replay with a durable voice artifact:
- if there is no `started` event for the current retry generation, treat the artifact as pre-existing and do not meter it;
- if `started` exists but `completed` does not, probe the existing durable artifact and complete the usage event without regenerating voice.

### Render
- one final-render operation;
- kind `render_minute`;
- units `project.durationMs / 60000` from canonical project metadata;
- provider `ffmpeg-container`;
- completed only after a valid project-scoped final export object key is available.

## 8. Migration

Add to `usage_events`:
- `job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`;
- `phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'))`;
- `operation_key TEXT`.

Add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_operation_phase
  ON usage_events(operation_key, phase)
  WHERE operation_key IS NOT NULL;
```

Existing historical rows remain valid and require no synthetic operation key.

## 9. Repository boundary

`worker/src/db/usage.ts` provides:
- `record(input): Promise<UsageEvent>`;
- `getByOperation(operationKey, phase): Promise<UsageEvent | null>`;
- `summarizeForUser(userId): Promise<UsageSummary>`;
- `summarizeForProject(projectId, userId): Promise<UsageSummary>`;
- `getCreditBalance(userId): Promise<number>`.

Project summary must fail closed with `PROJECT_NOT_FOUND` when ownership does not match.

Totals:

```ts
{
  asrAudioMinutes: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  renderMinutes: number;
}
```

Provider breakdown uses the same shape and completed rows only.

## 10. Workflow integration

`DubbingWorkflow` and `ExportWorkflow` construct `UsageRepository` and inject only the narrow usage interface.

Usage failures are not silently swallowed. Metering must not intentionally repeat already-durable TTS generation merely because a later probe/ledger completion failed.

## 11. API

Authorized routes:
- `GET /api/usage` — current-user summary + informational credit balance;
- `GET /api/projects/:id/usage` — owned-project summary.

No route accepts client `userId`. Cross-user project access returns 404.

## 12. Dashboard

Show a compact independent usage panel with:
- informational internal credits;
- ASR minutes;
- translation characters;
- generated voice seconds;
- render minutes;
- provider breakdown.

Usage loading/error is isolated from persisted project/job state. No payment CTA, upgrade prompt, quota warning, or fake money estimate.

## 13. Precision

Do not round in repository/API summaries. UI may round minutes/seconds to at most two decimals; character counts remain integers.

## 14. Required tests

- duplicate same operation/phase returns one canonical event;
- started/completed coexist;
- canonical lookup works;
- completed-only summaries and provider precision;
- unauthorized project fails closed;
- ASR replay and explicit retry generation;
- translation provider attribution;
- pre-existing TTS artifact is not metered;
- started-but-incomplete current-generation TTS reuses/probes durable artifact without regeneration;
- new TTS usage uses probed generated-audio seconds;
- render uses durable project minutes;
- usage API authorization;
- dashboard usage failure isolation;
- no Phase 3B path decrements credits.

## 15. Qualification

Every task follows RED -> GREEN. Before merge: full verify, exact-head CI including Wrangler/screenshots/artifact, reverse-sync current `main` if advanced, rerun exact-head CI, expected-head merge, then post-merge `main` full GREEN.

Source/CI success does not qualify production runtime.
