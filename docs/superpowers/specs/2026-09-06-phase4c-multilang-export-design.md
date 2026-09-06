# Phase 4C — Multi-language batch export design

Date: 2026-09-06
Status: Approved design, source/CI qualification only
Base: `main@e2c81f00ff195a66661d4e651f0316820f7aa7c8`

## 1. Goal

Add bounded multi-language dubbing/export support without breaking the existing Vietnamese-first project and Studio behavior.

A project may enable several target languages, persist translated/dubbed state independently per target, render independent export artifacts, and request a bounded batch export across several targets. Existing API calls that omit a target language continue to mean Vietnamese (`vi`).

Phase 4C is repository source/CI qualification only. It does not deploy production and does not change the existing production-runtime qualification boundary.

## 2. Scope

In scope:

- target languages: `vi`, `en`, `ja`, `ko`, `zh` only;
- at most four target languages in one batch request;
- independent persisted translation, dubbed-audio and export state per target;
- backward-compatible Vietnamese behavior;
- target-aware translation, voice regeneration and export orchestration;
- batch export fan-out with per-target terminal results;
- target-aware invalidation;
- export sharing tied to one concrete export variant;
- a compact Studio surface for choosing targets and viewing per-target status;
- additive abuse-control and existing Phase 3B usage accounting for real provider/render work.

Out of scope:

- arbitrary BCP-47 target languages;
- simultaneous editing of five full transcript panes;
- automatic provider qualification for every target;
- background/dialogue separation;
- visual lip-sync rendering;
- payment/pricing/quota changes;
- production deployment or runtime PASS claims.

## 3. Compatibility rules

The current `projects.target_language` column remains unchanged and continues to represent the legacy/default Vietnamese editing surface. Existing APIs that do not provide a target language use `vi`.

The current `segments.translated_text`, `segments.translation_status`, `segments.voice_status`, `segments.dubbed_object_key`, and `projects.export_object_key` remain the legacy Vietnamese mirrors. Phase 4C does not remove or repurpose them.

For `vi`, writes to the new target-aware stores must keep the legacy mirror fields consistent. Reads through legacy endpoints continue to use the existing fields so current clients remain valid.

Non-`vi` targets never overwrite legacy Vietnamese columns.

## 4. Data model

Add `migrations/0009_multilang_exports.sql`.

### 4.1 `project_targets`

One row per enabled project target language.

Fields:

- `project_id` FK -> projects, cascade delete;
- `target_language` constrained to `vi|en|ja|ko|zh`;
- `enabled` integer with `CHECK (enabled IN (0,1))`;
- `created_at`, `updated_at`;
- primary key `(project_id, target_language)`.

`vi` is logically enabled for all existing projects even when no row exists, so migration does not need to backfill every project synchronously.

### 4.2 `segment_translations`

One row per segment + target language.

Fields:

- `segment_id` FK -> segments, cascade delete;
- `project_id` FK -> projects, cascade delete;
- `target_language`;
- `translated_text`;
- `translation_engine`;
- `translation_status`;
- `context_revision` nullable;
- `source_segment_version` integer;
- `version` integer >= 1;
- timestamps;
- primary key `(segment_id, target_language)`.

The row is valid only for the recorded source segment version. A source/timing mutation invalidates all target rows for that segment.

### 4.3 `segment_dubs`

One row per segment + target language.

Fields:

- `segment_id`, `project_id`, `target_language`;
- `status`;
- `object_key` nullable;
- `voice_provider` nullable;
- `voice_id` nullable;
- `translation_version` integer;
- `segment_version` integer;
- `duration_ms` nullable;
- timestamps;
- primary key `(segment_id, target_language)`.

The object key must be inside a project- and target-scoped prefix such as:

`projects/{projectId}/dubbed/{targetLanguage}/{segmentId}/{version}.mp3`

### 4.4 `project_exports`

One durable export variant per export attempt.

Fields:

- `id` primary key;
- `project_id` FK -> projects, cascade delete;
- `target_language`;
- `status` (`queued|running|failed|completed|cancelled`);
- `object_key` nullable;
- `job_id` nullable;
- `error_code` nullable;
- `generation_key` non-null and unique per logical target render attempt;
- timestamps.

The generation key must include project, target language and the durable export generation/retry identity so Workflow replay of the same logical target render is idempotent while a user-requested new render can create a new generation.

Completed object keys are target-scoped:

`projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`

For a completed Vietnamese export, `projects.export_object_key` mirrors the latest valid `vi` artifact for backward compatibility.

## 5. API contract

### 5.1 Project targets

Add owner-scoped endpoints:

- `GET /api/projects/:id/targets`
- `PUT /api/projects/:id/targets`

The PUT body supplies a deduplicated target list from the bounded language set. `vi` cannot be disabled from the legacy project contract; clients may omit it and the server still treats it as available.

### 5.2 Target-aware existing operations

Translation, regenerate-voice and export APIs accept an optional `targetLanguage`. Omitted means `vi`.

Invalid/unsupported target language is rejected before provider calls, workflow creation, limiter consumption, usage events, or durable media mutation.

### 5.3 Batch export

Add:

`POST /api/projects/:id/exports/batch`

Body:

```json
{
  "targetLanguages": ["vi", "en", "ja"]
}
```

Rules:

- ownership first;
- parse and validate body;
- 1–4 distinct target languages;
- each language must be in the bounded set;
- only after authorization and validation consume the batch limiter;
- create independent per-target export operations;
- no provider/workflow side effects if admission fails.

The endpoint does not create a new persisted batch table or new job-state enum. It returns the child target operation identifiers and initial statuses. Reloaded batch/progress UI derives aggregate state from those target export records: all completed -> `completed`; mixed completed plus failed/cancelled -> `partial`; all terminal and none completed -> `failed`; otherwise -> `running`.

One target failing later does not roll back another target that completed successfully.

### 5.4 Export read/list/share

Owner export listings become variant-aware and include target language and export id.

Sharing must bind to a concrete completed `project_exports.id`. Existing Vietnamese share creation without an explicit export id may resolve to the current valid Vietnamese mirror for compatibility; new multi-language UI always sends a concrete export id.

Anonymous token validation, expiry, revocation, no-referrer policy and byte-range streaming semantics remain unchanged.

## 6. Workflow architecture

Batch orchestration is fan-out, not one monolithic multi-language media render.

For each admitted target:

1. Load immutable source segment/version snapshot.
2. Resolve or generate target translation.
3. Generate per-segment dubbed audio for that target.
4. Fit audio to existing segment timing.
5. Build a target-specific export manifest.
6. Invoke the existing FFmpeg export boundary.
7. Persist `project_exports` completion and R2 object key.
8. Mirror to legacy Vietnamese columns only when target is `vi`.

Each target has independent retry/idempotency identity. Retry of one failed target must not regenerate or re-meter completed work for another target.

Batch summary is always derived from the child target export states and is never its own persisted authority.

## 7. Translation semantics

Phase 4A translation context remains authoritative.

Each target translation operation captures one immutable context snapshot/revision. Glossary/style context is reused where the configured provider path supports it.

Raw provider paths must not silently claim contextual translation support. If a configured target/provider combination is unavailable, that target fails with a bounded error code and other targets continue.

Changing project glossary/style does not automatically rewrite already persisted target translations.

## 8. Voice semantics

Speaker voice assignment remains project/speaker scoped. A speaker voice may be reused across supported target languages only when the selected provider path can generate that target.

A target/provider mismatch fails that target explicitly; the system does not silently substitute a different provider or voice unless the existing provider contract already defines that fallback for the same operation.

Changing a speaker voice invalidates that speaker's `segment_dubs` across all target languages and invalidates completed exports that depended on those dubs.

Managed clone lifecycle rules from Phase 4B are unchanged.

## 9. Invalidation matrix

### Source text/timing/structural segment mutation

Invalidate for that segment across all targets:

- target translations;
- target dubs;
- target exports that depend on them.

### Target translation edit/regeneration

Invalidate only that target's:

- segment dub;
- dependent project export.

Other target languages remain valid.

### Speaker voice change

Invalidate that speaker's dubs for every target language and all exports depending on them.

### Glossary/style revision

Do not automatically invalidate existing translations. New translation/retranslation operations use the new immutable context revision.

### Project source replacement/deletion

Existing project-wide invalidation/deletion authority applies to all new target-aware rows and media prefixes.

## 10. Usage accounting

Phase 3B remains the accounting source of truth.

Every actual target translation records the same existing translation-character accounting semantics. Every actual TTS generation records generated-audio units under the existing TTS accounting semantics. Every actual final render records render units under the existing render semantics.

The target language may be included in bounded operation metadata/idempotency keys, but Phase 4C does not invent pricing, decrement credits, or add fake aggregate batch units.

Retry/idempotency keys include enough target/generation identity to prevent replay from duplicating completed logical work.

## 11. Rate limiting

Keep all existing Phase 3C lanes and Phase 4B clone lane unchanged.

Add one isolated binding:

- `RATE_LIMIT_BATCH_EXPORT`
- namespace id `31007`
- `2/min` per server-derived actor key.

Single-target exports continue to use `RATE_LIMIT_EXPORT` (`4/min`).

Batch admission ordering is:

`current user -> project ownership -> parse/validate/dedupe targets -> batch limiter -> durable operation creation`.

The limiter is abuse control only and never writes Phase 3B usage state.

## 12. Studio UX

Keep Vietnamese as the primary editing surface.

Add a compact export target selector with chips for `VI`, `EN`, `JA`, `KO`, `ZH`. The user may choose at most four targets for one batch export.

The UI shows per-target status independently, for example:

- `VI · Hoàn tất`
- `EN · Đang render`
- `JA · Lỗi TTS · Thử lại`

The UI must not imply that an unavailable provider/language combination is ready. It must display target-specific failures without hiding completed siblings.

Phase 4C does not introduce parallel full transcript editors for every target.

## 13. Error handling and safety

- Cross-user/missing project access stays hidden behind existing 404 semantics.
- Unsupported target language returns a stable bounded client error.
- Provider bodies, secrets, raw media and transcript payloads do not enter telemetry.
- R2 keys are validated to stay inside the project/target prefix.
- Partial batch success is explicit and durable; no all-or-nothing rollback of completed artifacts.
- Failed target retry is target-scoped.
- Share tokens never encode export metadata in plaintext as an authorization substitute; server-side share records remain authoritative.

## 14. Testing and acceptance

Create `tests/phase4c-multilang-export-acceptance.test.mjs` and wire it into the existing source verification script before production implementation.

Acceptance must cover at minimum:

1. migration `0009_multilang_exports.sql` exists and defines all target-aware tables/constraints;
2. legacy omitted-language path remains Vietnamese;
3. supported language set is exactly bounded to `vi,en,ja,ko,zh` for this phase;
4. batch request rejects empty, duplicate-only/invalid, unsupported or >4 target lists before durable/provider side effects;
5. dedicated `RATE_LIMIT_BATCH_EXPORT` binding exists and does not weaken prior limiter invariants;
6. translation/TTS/render persistence and idempotency are target-scoped;
7. source mutation invalidates all targets, target translation mutation invalidates only one target, speaker voice mutation invalidates all relevant target dubs/exports;
8. completed target A survives target B failure;
9. `vi` writes mirror the legacy columns while non-`vi` writes never overwrite them;
10. export object keys include the target language;
11. share creation can bind one concrete completed export variant while legacy Vietnamese sharing remains compatible;
12. Phase 3B usage is recorded per real operation and batch admission does not create usage events;
13. ownership isolation and telemetry redaction remain intact;
14. Studio target selection is capped at four and renders independent per-target states;
15. full Vitest, TypeScript/Vite build, Wrangler dry-run and reference screenshots pass on the exact feature head and PR merge-ref.

## 15. Merge and qualification gates

Implementation follows TDD:

1. commit spec;
2. write implementation plan;
3. create RED acceptance/focused tests;
4. prove RED on exact head;
5. implement minimally to GREEN;
6. run full exact-head CI including Wrangler dry-run and reference screenshots;
7. review diff and unresolved PR discussion;
8. rebase/reconcile non-force if `main` drifted;
9. PR merge-ref CI must be GREEN;
10. merge using the expected feature head;
11. exact merge-SHA post-merge CI must be GREEN.

No production deploy workflow is triggered by Phase 4C.

## 16. Production qualification boundary

GREEN source/CI proves repository contracts only.

Production multi-language export remains UNQUALIFIED until a real deployed fixture demonstrates at least two distinct non-empty target languages through translation, target-compatible TTS, FFmpeg render, persisted target-specific R2 artifacts, owner retrieval/share behavior, per-target usage accounting, and isolated retry behavior.

The existing Cloudflare Container credential blocker and all previously documented real provider/media qualification requirements remain in force.
