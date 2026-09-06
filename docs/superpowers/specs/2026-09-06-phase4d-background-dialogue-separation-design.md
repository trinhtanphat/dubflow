# DubFlow Phase 4D — Background / Dialogue Separation Design

Date: 2026-09-06
Status: User-approved architecture; written spec pending review
Base: `main` at `baa02d2ff62e064ba00abcfe280d098b54074031`
Carrier: `feat/phase4d-background-dialogue-separation`

## 1. Goal

Phase 4D adds durable source-audio separation so dubbed exports can preserve music and ambience while replacing source dialogue.

The current canonical export path renders dubbed voices over a silent base. That behavior remains the default until Phase 4D is qualified on real media. Phase 4D adds an opt-in `preserve_background` mix mode that uses a previously separated background stem as the render base.

This phase must preserve Phase 4C multi-language isolation, immutable export identity, concrete sharing, usage idempotency, cancellation/retry semantics, and the current Cloudflare Workers Builds deployment policy.

## 2. Decision

The canonical implementation is a **dedicated source-separation container** behind an `AudioSeparationProvider` boundary.

Separation is not embedded in the existing `FfmpegContainer` because the two workloads have different characteristics:

- FFmpeg rendering is deterministic media transformation.
- Source separation is model inference with different CPU, memory, model-provenance, retry, and qualification requirements.
- The existing FFmpeg container is `standard-1`; separation can be sized independently without forcing every render to use a larger instance.
- One valid separation result should be reused by every target-language export for the same source revision.

A provider boundary also allows a future external provider or replacement model without changing the export workflow contract.

## 3. Initial model target

The first qualification target is a pinned two-stem Demucs `htdemucs`-compatible model producing vocals/dialogue and accompaniment/background stems.

The provider/model identity must be explicit and persisted. The container image must pin:

- separation runtime/package version;
- model id;
- model weights digest;
- any model-specific preprocessing configuration that changes output semantics.

No production request may download a floating `latest` model on first use.

The original Meta Demucs repository is archived, so the implementation must treat upstream as immutable reference material rather than a moving dependency. A maintained fork or equivalent compatible model may be used only if the exact package/model identity is pinned and the same provider contract is preserved.

## 4. Product behavior

Dubbed exports expose two modes:

```ts
type DubbedMixMode = 'dubbed_only' | 'preserve_background';
```

### `dubbed_only`

- Exact existing Phase 4C behavior.
- Dubbed clips are mixed over silence.
- No separation state is required.
- This remains the default when the field is omitted.

### `preserve_background`

- Uses a completed background stem for the current source revision and canonical provider/model identity.
- Dubbed clips are mixed over that stem.
- Original source audio is not mixed into the result, because doing so would reintroduce source dialogue.
- If separation is unavailable, unqualified, stale, running, failed, or structurally invalid, export fails closed.
- It never silently falls back to `dubbed_only` or raw source audio.

## 5. Qualification boundary

Source/CI qualification is not perceptual audio-quality qualification.

Before real-media qualification:

- `dubbed_only` remains the production default;
- `preserve_background` is opt-in and visibly marked preview/unqualified;
- no source/CI test may claim that dialogue removal quality is production-grade.

## 6. Source identity

Separation artifacts must not be keyed only by project id. A project can receive a replacement source upload while retaining its identity.

Migration `0011_audio_separation.sql` adds:

```sql
ALTER TABLE projects ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
```

Migration/backfill rules:

- existing projects with non-null `source_object_key` are backfilled to source revision `1`;
- projects without source media remain revision `0`;
- `ProjectRepository.setSourceObject()` increments `source_revision` atomically whenever a completed upload becomes the canonical source;
- replacing source media therefore invalidates prior separation identity without requiring destructive cleanup.

The project domain/DTO exposes `sourceRevision` as read-only state.

## 7. Separation persistence

Migration `0011_audio_separation.sql` creates `project_audio_separations`.

Required schema:

```sql
CREATE TABLE project_audio_separations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  source_object_key TEXT NOT NULL,
  source_size_bytes INTEGER,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','invalidated')),
  dialogue_object_key TEXT,
  background_object_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(project_id, source_revision, provider, model_digest)
);
```

Repository invariants:

- owner-scoped project authorization is required for all reads/writes;
- a completed row is valid only if both durable stem keys are present;
- returned keys must be exact project/source/provider/model scoped;
- rows for older source revisions are never returned as current;
- retry mutates the same canonical identity rather than creating competing completed rows.

## 8. R2 layout

Canonical immutable stem keys:

```text
projects/{projectId}/separation/{sourceRevision}/{provider}/{modelDigest}/dialogue.wav
projects/{projectId}/separation/{sourceRevision}/{provider}/{modelDigest}/background.wav
```

Rules:

- WAV is the canonical intermediate to avoid repeated lossy recompression.
- Temporary model chunks may exist only in container-local storage or a clearly temporary project prefix.
- Final stitched stems are the only reusable canonical artifacts.
- Historical source/model generations are never overwritten by newer ones.
- Any response containing a cross-project or unexpected key is rejected.

## 9. Provider contract

Add `worker/src/services/separation/types.ts`:

```ts
export type SeparationRequest = {
  projectId: string;
  sourceObjectKey: string;
  sourceRevision: number;
  provider: string;
  modelId: string;
  modelDigest: string;
};

export type SeparationResult = {
  dialogueObjectKey: string;
  backgroundObjectKey: string;
  durationMs: number;
};

export type SeparationCapabilities = {
  configured: boolean;
  qualified: boolean;
  provider: string;
  modelId: string;
  modelDigest: string;
  maxDurationMs?: number;
};

export interface AudioSeparationProvider {
  capabilities(): Promise<SeparationCapabilities>;
  separate(input: SeparationRequest): Promise<SeparationResult>;
}
```

The Worker owns project scoping and expected key derivation. The provider/container is not trusted to choose arbitrary R2 paths.

## 10. Dedicated separator container

Add `containers/separator/` with its own Dockerfile, model runtime, tests, and narrow HTTP server.

Initial route:

```text
POST /separate
```

The request contains validated project/source/model metadata only. No arbitrary shell arguments or filenames from user input are accepted.

Container stages:

1. load/copy the source media through the controlled project media boundary;
2. normalize audio to the model's required sample rate/channel format;
3. run two-stem separation;
4. stitch/normalize stems if the model internally chunks input;
5. verify both durations are positive and within a bounded tolerance of source duration;
6. publish canonical dialogue/background stem objects;
7. return exact keys plus measured duration.

The model runtime and weights are included or fetched at image-build time with a pinned digest. Production first request must not perform an unverified model download.

## 11. Container sizing

The existing renderer stays `standard-1`.

The separator is configured independently. Initial source/config qualification target:

```json
{
  "class_name": "SeparatorContainer",
  "image": "./containers/separator/Dockerfile",
  "instance_type": "standard-4"
}
```

Cloudflare currently documents `standard-4` as 4 vCPU / 12 GiB memory / 20 GB disk. This is a starting capacity assumption for CPU inference, not a throughput guarantee.

Real-media benchmarks may justify a smaller type later, but only after measured evidence.

## 12. Worker container adapter

Add `worker/src/services/separation/container.ts` with a `ContainerAudioSeparationProvider`.

It mirrors the existing defensive media-container pattern:

- one named container instance per project identity;
- request body is validated before call;
- non-2xx becomes a stable provider error;
- response shape is validated;
- both keys must equal the canonical expected project/source/model prefixes;
- duration must be positive finite metadata;
- capability returns `qualified=false` until runtime qualification/config explicitly enables it.

## 13. Workflow orchestration

Add:

- `worker/src/workflows/SeparationWorkflow.ts`
- `worker/src/workflows/separationPipeline.ts`

A normal durable job is created with `type='separation'`.

Canonical sequence:

1. authorize project;
2. snapshot `sourceRevision`, source key, source size, and project duration;
3. resolve canonical provider/model capabilities;
4. reject unavailable/unqualified provider before billable work;
5. load or create canonical separation identity;
6. if a completed durable identity already exists, reuse it;
7. check cancellation;
8. mark job/separation running;
9. record idempotent usage `started`;
10. invoke provider under provider telemetry;
11. validate keys and duration;
12. check cancellation before publish completion;
13. persist both durable stem keys and completed status;
14. record usage `completed`;
15. complete the job.

Workflow step results contain metadata only. Audio bytes never live in Workflow state.

## 14. Separation API

Add:

```text
POST /api/projects/:id/separation
GET  /api/projects/:id/separation
```

### POST semantics

Idempotently ensure the canonical separation for the current source revision/provider/model.

- completed identity -> return it; do not start new provider work;
- active identity -> return existing job/state;
- failed identity -> explicit retry flow increments the job retry generation and reuses the same canonical separation identity;
- no identity -> create separation row + job + Workflow instance.

The route uses a dedicated expensive-operation rate limit before creating new provider work.

### GET semantics

Return only the current source revision's canonical separation status and safe provenance:

- status;
- provider;
- model id;
- source revision;
- created/completed timestamps;
- job id when active/retryable.

Do not expose signed media credentials or internal container details.

## 15. Rate limiting

Add a dedicated binding:

```text
RATE_LIMIT_SEPARATION
```

Initial limit: 2 separation starts per user per minute.

Reusing an already active/completed canonical identity does not create another provider operation.

The binding gets a new namespace id and is independently test-locked so separation does not accidentally consume the generic export limiter.

## 16. Usage ledger

Add usage kind:

```text
audio_separation_minute
```

Canonical operation key:

```text
project:{projectId}:source:{sourceRevision}:separation:{provider}:{modelDigest}
```

This deliberately excludes target language and export id.

Consequences:

- `vi`, `en`, `zh`, `ja`, and `ko` reuse the same separation artifact;
- multi-language batch export does not charge or rerun separation per language;
- retry can recover a missing completed usage event from durable stems;
- a completed usage event with missing durable stems is an invariant violation and fails closed.

Units are source audio minutes derived from validated duration metadata.

## 17. Export API

Extend dubbed export request input:

```ts
mixMode?: 'dubbed_only' | 'preserve_background';
```

Rules:

- omitted -> `dubbed_only`;
- subtitles reject/ignore no audio-only hidden fields; request validation remains explicit;
- batch dubbed export applies one requested mix mode to all target-language attempts;
- export DTO stores/returns the resolved mix mode so an artifact's provenance is visible.

`preserve_background` does not secretly start separation inside `ExportWorkflow`. The Studio/API explicitly prepares separation first, and export requires a completed current identity.

## 18. Export persistence

Migration `0011_audio_separation.sql` also adds a non-null/default-safe mix provenance field to canonical `project_exports`:

```sql
ALTER TABLE project_exports ADD COLUMN mix_mode TEXT NOT NULL DEFAULT 'dubbed_only'
  CHECK (mix_mode IN ('dubbed_only','preserve_background'));
```

If SQLite/D1 cannot apply the desired CHECK via direct ALTER in the target version, use the repository's forward table-rebuild pattern and preserve every existing export/share identity.

Historical rows remain `dubbed_only`.

## 19. Export workflow integration

Extend `RenderExportOptions`:

```ts
export type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  mixMode?: DubbedMixMode;
  backgroundObjectKey?: string;
};
```

### `dubbed_only`

Exact current behavior. No separation lookup required.

### `preserve_background`

Before render:

1. load current project source revision;
2. load completed canonical separation identity;
3. require matching source revision/provider/model digest;
4. require a valid durable background key;
5. pass only the validated background key into media rendering.

Stable errors include:

- `SEPARATION_UNAVAILABLE`
- `SEPARATION_NOT_READY`
- `SEPARATION_SOURCE_STALE`
- `SEPARATION_ARTIFACT_MISSING`
- `SEPARATION_RESPONSE_INVALID`

Failure affects only the requested preserve mode; `dubbed_only` remains available.

## 20. MediaProcessor validation

`ContainerMediaProcessor.renderExport()` validates:

- source object belongs to project;
- target-language voice clips belong to exact target prefix;
- `dubbed_only` forbids a background key;
- `preserve_background` requires a background key under exact canonical separation prefix;
- modern target output key remains `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`.

No user-provided arbitrary storage prefix reaches FFmpeg.

## 21. FFmpeg render graph

### `dubbed_only`

Preserve the current graph:

- `anullsrc` base;
- target dubbed clips resampled/tempo-fitted/timeline-delayed;
- amix;
- existing video/audio output settings.

### `preserve_background`

Inputs:

- source video;
- background WAV stem;
- target dubbed clips.

Graph:

- background stem -> 48 kHz stereo normalized base;
- target dubbed clips -> existing tempo fitting and timeline delays;
- background + clips -> amix;
- source video's original audio is **not** mapped into the final mix;
- video mapping and output duration remain unchanged.

This behavior is locked by container tests so a later refactor cannot accidentally reintroduce source dialogue.

## 22. Frontend

Add a compact audio treatment section near export/batch-export controls.

Options:

- `Dubbed voices only`
- `Preserve music & ambience`

Required states for preserve mode:

- `Not prepared` -> show `Prepare background` action;
- `Processing` -> durable job progress;
- `Ready` -> selectable only if provider capability is qualified;
- `Failed` -> safe retry action and error summary;
- `Stale` -> source has changed, old artifact not selectable;
- `Unqualified` -> preview label; no production-quality claim.

Opening Studio must not auto-start expensive separation.

## 23. Telemetry

Add operations:

- `separation_start`
- `separation_reuse`
- `separation_success`
- `separation_failure`
- `export_preserve_background`

Allowed fields include:

- request id;
- opaque user id;
- project id;
- source revision;
- job id;
- provider/model id;
- status/duration/error code.

Never log transcript text, source filenames, raw media URLs, tokens, or credentials.

## 24. Cancellation and retry

- check cancellation before provider inference;
- check again before publishing completed separation state;
- cancelled jobs never transition back to completed;
- retry generation is part of job state but not separation artifact identity;
- if durable completed stems exist after an uncertain provider response, recover state/usage instead of rerunning inference;
- provider failure does not invalidate a previously valid completed identity for the same exact source/model;
- new source revision never reuses old stems.

## 25. Security

- authorize project ownership before separation lookup or start;
- validate duration/provider capacity before expensive work;
- no arbitrary shell commands or paths from request data;
- provider/model names come from server configuration, not user-controlled command arguments;
- secrets remain Cloudflare secrets;
- canonical stem keys are derived server-side;
- cross-project provider/container output fails closed;
- no public R2 bucket is required.

## 26. Testing strategy

TDD is mandatory.

### Migration/repository

- `0010 -> 0011` executes with `foreign_key_check` clean;
- source revision backfill;
- `setSourceObject` atomic increment;
- separation uniqueness;
- owner scoping;
- completed row requires both keys;
- stale source revision is not returned current;
- export mix-mode migration preserves existing ids/shares.

### Provider/container adapter

- capabilities unavailable/unqualified/qualified matrix;
- exact request model identity;
- malformed/cross-project response rejection;
- duration validation;
- exact canonical keys;
- no floating model id accepted.

### Separator container

- request validation;
- deterministic output-path derivation;
- two stem outputs required;
- duration tolerance;
- model command receives only server-owned arguments;
- temporary artifacts cannot escape project scope.

CI may use a tiny deterministic fake/model fixture for contract tests; it must not claim perceptual separation quality.

### Workflow

- first run -> one started + one completed usage event;
- second target export -> zero new separation provider calls;
- retry recovers durable artifact without duplicate charge;
- cancellation before inference;
- cancellation before completion publish;
- provider failure durable error state;
- completed usage without artifacts fails closed.

### Export

- omitted mix mode -> byte/graph-compatible `dubbed_only` behavior;
- preserve mode requires current completed separation;
- stale/missing separation fails only preserve mode;
- background key sent to media renderer exactly;
- no source audio remixed in preserve graph;
- target-language output keys remain exact.

### Frontend

- no auto-start on Studio load;
- prepare/progress/ready/failed/stale/unqualified states;
- exact mix mode included in dubbed export request;
- subtitle flow unaffected;
- batch export uses one mix selection across target attempts.

### Acceptance/CI

Fresh CI must include:

- source acceptance tests;
- Vitest;
- TypeScript/Vite production build;
- Wrangler dry-run;
- both FFmpeg and separator container bindings/classes;
- SeparationWorkflow binding;
- separator contract tests;
- existing CJK screenshot/reference artifact lane.

## 27. Runtime qualification

Phase 4D remains runtime **UNQUALIFIED** after source merge until a real fixture proves all of the following:

1. source contains dialogue plus music/ambience;
2. separation completes with exact durable project-scoped dialogue/background stems;
3. source dialogue is materially reduced/removed from the background stem without catastrophic ambience loss;
4. `preserve_background` produces a playable dubbed MP4 with correct duration;
5. at least two target-language exports reuse the same separation identity;
6. retry does not duplicate separation usage;
7. `dubbed_only` remains unchanged and operational.

Perceptual quality evidence must come from real media, not a mocked CI fixture.

## 28. Deployment boundary

GitHub Actions remains CI-only.

`main` remains the sole production source of truth. Cloudflare Workers Builds remains the only production deployment lane.

The D1 deployment preparation added on current `main` must be preserved. Phase 4D's migration `0011` must flow through the repository's existing Workers Builds migration/deploy preparation path.

No manual production deploy is part of this phase.

## 29. Current Cloudflare constraints

Current Cloudflare documentation states:

- `standard-4`: 4 vCPU, 12 GiB memory, 20 GB disk;
- custom Container types are capped at 4 vCPU and 12 GiB memory;
- Workflows permit unlimited wall-clock step duration while waiting on network/database I/O, while active CPU remains bounded;
- R2 remains the durable object store for large separation artifacts.

Therefore model inference belongs in the dedicated container, while Workflow state carries only metadata/checkpoints.

These are capacity assumptions, not promises about throughput or model quality.

## 30. Non-goals

Phase 4D does not include:

- visual lip-sync;
- speaker-specific source separation;
- custom model training/fine-tuning;
- browser-side separation;
- silent automatic fallback between mix modes;
- making preserve-background the default before runtime qualification;
- deleting all historical stems immediately on source/model changes;
- claiming CI proves perceptual audio quality.

## 31. Follow-on

After Phase 4D is source/CI complete and real-media qualified, the remaining advanced-dubbing roadmap item is the optional visual lip-sync provider. It must be designed as its own subsystem rather than being coupled into separation or FFmpeg rendering.
