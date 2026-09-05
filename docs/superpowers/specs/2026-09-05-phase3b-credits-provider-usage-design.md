# Phase 3B Credits Ledger + Provider Usage Metrics Design

Date: 2026-09-05
Status: Approved continuation of the Phase 3 roadmap

## Goal

Add an internal, durable credits ledger and provider usage metrics without turning credits into a payment wall. Phase 3B measures real billable work, exposes account usage in the YupVox dashboard, and preserves retry/idempotency behavior from Phase 3A.

## Scope

Included:
- append-only usage events in D1;
- deterministic idempotency for Workflow-backed provider work;
- internal credit calculation from normalized usage units;
- account-wide balance/usage/provider summaries;
- metering for dubbing ASR + translation, export TTS + render, segment retranslation, and voice preview;
- dashboard visibility for allocation, consumed credits, remaining credits, and provider totals;
- source/CI acceptance coverage.

Excluded:
- payments, subscriptions, top-up checkout, invoices, or provider billing reconciliation;
- hard blocking when credits reach zero;
- request rate limits or abuse throttling (Phase 3C);
- observability/log aggregation (Phase 3C);
- share/download controls (Phase 3D);
- production deployment or runtime qualification.

## Credits Semantics

`users.credit_balance` remains the user's allocated internal credits. Existing development-user seeding at 50,000 credits remains unchanged.

Phase 3B does not mutate `users.credit_balance` for every provider call. Instead:

- `allocatedCredits = users.credit_balance`;
- `usedCredits = SUM(usage_events.credits)`;
- `remainingCredits = MAX(0, allocatedCredits - usedCredits)`;
- `overageCredits = MAX(0, usedCredits - allocatedCredits)`.

This keeps the usage ledger append-only and avoids cross-table partial-debit failure. Hard enforcement is intentionally deferred until Phase 3C has a defined abuse/limit policy.

## Usage Event Model

The existing `usage_events` table is extended with:
- `job_id TEXT NULL` — durable job correlation where a Workflow owns the work;
- `idempotency_key TEXT NULL` — deterministic key for replay-safe metering;
- `credits INTEGER NOT NULL DEFAULT 0` — internal credits consumed by this event.

A partial unique index on non-null `idempotency_key` makes the write replay-safe.

Domain shape:

```ts
export type UsageKind =
  | 'asr_audio_seconds'
  | 'translation_characters'
  | 'tts_characters'
  | 'render_seconds';

export type UsageEvent = {
  id: string;
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: UsageKind;
  units: number;
  provider: string;
  creditRate: number;
  credits: number;
  createdAt: string;
};
```

`cost_basis` remains the persisted numeric column but is interpreted in Phase 3B as the internal `creditRate` (credits per measured unit), not as USD or a claim about current provider pricing.

## Internal Credit Rates

These rates are deliberately product-internal and provider-price-independent:

- ASR: 1 credit per 6 audio seconds;
- translation: 1 credit per 200 source characters;
- TTS: 1 credit per 50 generated-input characters;
- render: 1 credit per 30 source-media seconds.

For non-zero usage, credits are `max(1, ceil(units / divisor))`. Zero units are rejected for billable events so empty provider calls never create usage rows.

The rate table lives in one domain module and is covered by deterministic unit tests. No external provider price is embedded in the code.

## Idempotency and Retry Semantics

Workflow parameters gain optional `usageAttempt?: number`, defaulting to `0`.

Initial process/export jobs use attempt `0`. A Phase 3A manual retry already increments `job.retryCount`; retry dispatch passes that value as `usageAttempt`.

Workflow event keys include job + attempt + stable stage identity:

```text
job:{jobId}:attempt:{attempt}:asr:{chunkObjectKey}
job:{jobId}:attempt:{attempt}:translation:{batchOffset}
job:{jobId}:attempt:{attempt}:tts:{segmentId}
job:{jobId}:attempt:{attempt}:render
```

Consequences:
- replay/resume of the same Workflow attempt cannot duplicate a usage row;
- a real manual retry is a new attempt and can record new provider work;
- cached voice segments that skip provider generation produce no new TTS event;
- failed provider calls produce no usage event because metering is recorded only after a successful provider response/work boundary.

Non-Workflow user actions (segment retranslate and voice preview) record a fresh event after successful provider work. Existing optimistic version checks prevent duplicate segment retranslation after a successful persistence.

## Provider Labels

Provider labels are stable product identifiers, not display copy:
- ASR: `deepgram-nova-3` or `workers-ai-whisper-large-v3-turbo`;
- translation: `workers-ai` and/or `google`;
- voice: `elevenlabs`;
- render: `ffmpeg-container`.

DubbingWorkflow derives the ASR label from the same Deepgram configuration boundary used to construct the ASR provider.

## Repository and Summary API

Create `worker/src/db/usage.ts` with `UsageStore` and `UsageRepository`.

Required operations:

```ts
record(input: RecordUsageInput): Promise<{ event: UsageEvent; inserted: boolean }>;
summaryForUser(userId: string): Promise<UsageSummary>;
```

`record` validates finite positive units, known kind, computed credits, and performs `INSERT OR IGNORE` when an idempotency key is present. If the insert is ignored, it reads and returns the existing event rather than inventing another charge.

`summaryForUser` returns:

```ts
export type UsageSummary = {
  allocatedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  overageCredits: number;
  totals: Array<{ kind: UsageKind; units: number; credits: number }>;
  providers: Array<{ provider: string; kind: UsageKind; units: number; credits: number }>;
};
```

Add `GET /api/usage/summary`, scoped to `getCurrentUserId()`.

## Workflow Metering

### Dubbing

Inject `UsageStore` into `runDubbingPipeline`.

- After each successful ASR chunk, record `chunk.durationMs / 1000` as `asr_audio_seconds`.
- After each successful translation batch, record the sum of source text character lengths as `translation_characters` with provider `workers-ai`.
- Record usage before progress advancement but after the successful provider result, using deterministic Workflow idempotency keys.

### Export

Inject `UsageStore` into `runExportPipeline`.

- Only when `deps.voice.generate()` actually runs and succeeds, record translated input length as `tts_characters`, provider `elevenlabs`.
- After successful `renderExport`, record the source media duration as `render_seconds`, provider `ffmpeg-container`.
- To meter render duration deterministically, `ExportProject` includes `durationMs` and export authorization fails closed if duration is missing or invalid.

## Route Metering

### Segment retranslation

`createTranslationRoutes` constructs a UsageRepository.

After successful provider translation:
- `workers-ai` mode records one translation event;
- `google` mode records one translation event;
- `compare` records one event for each provider because both calls occurred.

No event is written on validation errors, provider errors, or version conflict detected before the provider call.

### Voice preview

`POST /api/voice/preview` records one `tts_characters` event with project/job null after ElevenLabs successfully returns audio. Each preview click is intentionally a distinct usage event because it represents distinct provider work.

## Frontend

Create a focused usage feature:
- `src/features/usage/usageApi.ts` — `getUsageSummary()`;
- `src/features/usage/UsageSummaryCard.tsx` — dashboard presentation;
- `src/features/usage/UsageSummaryCard.test.tsx`.

`App` loads usage summary together with the dashboard view. Usage failure is non-destructive to project data: the dashboard remains usable and shows a small usage-specific unavailable state rather than replacing the entire dashboard with an error.

The card shows:
- allocated / used / remaining credits;
- overage only when non-zero;
- grouped provider usage rows with kind, measured units, and credits.

No currency symbols or provider-cost claims are shown.

## Error Handling

- Usage repository input validation fails closed and does not insert malformed rows.
- Metering persistence failure after successful provider work is treated as a pipeline/route failure for Workflow-backed billable stages: a successful expensive call must not silently disappear from the ledger.
- Voice preview returns a stable `USAGE_RECORD_FAILED` response if audio generation succeeds but ledger persistence fails; it does not stream unmetered audio.
- Summary API returns 500 `USAGE_SUMMARY_FAILED` on repository failure.

## Testing

Required coverage:
- credit calculation boundaries;
- idempotent repository inserts and existing-event return;
- summary aggregation and remaining/overage math;
- authorized summary route;
- Workflow ASR/translation/TTS/render metering and replay keys;
- retry `usageAttempt` propagation;
- translation compare records both providers;
- voice preview records successful ElevenLabs usage only;
- frontend API + card states;
- source acceptance gate added to `npm run verify`;
- exact-head GitHub Actions GREEN before merge and fresh post-merge `main` GREEN.

## Qualification Boundary

Phase 3B source/CI completion does not qualify live Cloudflare runtime. Production remains manual-only and runtime remains UNQUALIFIED until the documented Cloudflare Containers credential and real-fixture gates pass.
