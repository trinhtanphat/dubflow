# Phase 4C — Batch + Multi-language Export Design

Date: 2026-09-06
Status: Design approved in chat; written spec pending user review before implementation planning
Branch: `feat/phase4c-multilanguage-export`
Baseline at spec creation: `e2c81f00ff195a66661d4e651f0316820f7aa7c8`

## 1. Goal

Extend YupVox/DubFlow from a single Vietnamese target into a project-level multi-language dubbing/export system without duplicating source media, ASR segments, timing, or speaker identity.

Phase 4C must let one project produce independent translation, subtitle, TTS, and export variants for multiple target languages while preserving all existing Phase 3B usage-accounting semantics, Phase 3C observability/rate-limit/share behavior, Phase 4A translation-context behavior, conservative/project-stable speaker stitching, and Phase 4B safe voice-clone enrollment.

Supported target languages for Phase 4C are:

- `vi` — Vietnamese
- `en` — English
- `zh` — Chinese
- `ja` — Japanese
- `ko` — Korean

The initial source-language set remains the existing supported set. Phase 4C does not expand source-language support unless required by provider mapping tests.

Production deployment is out of scope for this lane. Source/CI qualification does not imply production runtime qualification.

## 2. Non-goals

Phase 4C does not implement:

- visual lip-sync synthesis;
- background/dialogue source separation;
- new voice-cloning enrollment behavior;
- a new payment/billing system;
- translation chaining from one target language into another;
- browser-side media rendering;
- removal of existing Vietnamese compatibility fields;
- a redesign of speaker identity or diarization.

Phase 4C consumes the voice capability contract already present on `main`; it does not replace or fork Phase 4B safe voice-clone enrollment.

## 3. Architectural choice

Use language variants inside a single project.

The canonical project owns one source media object, one canonical source transcript, one timing/speaker graph, and many target-language variants. Each target language gets its own translated text, translation revision/provenance, TTS artifacts, export state, and final artifacts.

Rejected alternatives:

1. Cloning one project per target language duplicates media, jobs, source transcript state, and source edits.
2. Storing all translations in a JSON map inside `segments` makes optimistic concurrency, indexing, partial updates, migration, and owner-scoped reads unnecessarily weak.

## 4. Canonical source versus language variants

`segments` remains the canonical source/timing/speaker record.

Canonical fields include:

- segment ID;
- project ID;
- speaker ID;
- start/end timing;
- source text;
- split lineage;
- source-edit versioning.

Target-language state moves into dedicated rows keyed by segment and target language.

A target-language switch must never duplicate or mutate source timing, source segment identity, or speaker identity.

All translation providers translate from canonical source text. Phase 4C must never translate Japanese from Vietnamese, Korean from Japanese, or otherwise cascade target translations.

## 5. Data model

### 5.1 Migration

The branch reserves `migrations/0009_multilanguage_variants.sql`, because the baseline already contains `0008_voice_clones.sql`.

Before implementation merge/reconciliation, the migration sequence must be re-checked against live `main`. If another migration lands first, Phase 4C must be renumbered non-destructively before merge rather than creating a duplicate sequence.

### 5.2 Project target languages

Add a project-level optimistic-concurrency column:

- `projects.target_languages_revision INTEGER NOT NULL DEFAULT 1 CHECK (target_languages_revision >= 1)`.

Add `project_target_languages` with one row per enabled target language.

Required fields:

- `project_id`;
- `target_language`;
- `status`;
- created/updated timestamps.

The primary/unique key is `(project_id, target_language)`.

Allowed target language values are exactly `vi`, `en`, `zh`, `ja`, `ko`.

Per-language status values:

- `pending`;
- `translating`;
- `needs_review`;
- `ready`;
- `exporting`;
- `completed`;
- `failed`.

Any mutation that changes the enabled target-language set increments `projects.target_languages_revision` exactly once. Per-language status updates do not increment that revision.

The enabled language set revision is independent from source segment versions and translation-context revision.

### 5.3 Segment translations

Add `segment_translations` keyed uniquely by `(segment_id, target_language)`.

Required fields:

- `segment_id`;
- `project_id` for efficient owner/project scoping;
- `target_language`;
- `translated_text`;
- `translation_engine`;
- `translation_status`;
- `translation_context_revision` nullable for raw/pre-context results;
- `version` starting at 1;
- created/updated timestamps.

The row is the source of truth for a target-language translation variant.

Editing Japanese increments only the Japanese variant version. It must not conflict with or mutate Vietnamese/Korean variants.

### 5.4 Language exports

Add `project_exports` with an immutable export ID and project/target association.

Required fields:

- `id` primary key;
- `project_id`;
- `target_language`;
- `output_mode` in `dubbed | subtitles`;
- `status`;
- `export_object_key` nullable until complete;
- `subtitle_object_key` nullable;
- `error_code` nullable;
- `error_message` nullable;
- created/updated timestamps.

The schema must support multiple attempts while allowing deterministic lookup of the latest export for `(project_id, target_language, output_mode)` by stable ordering on creation time plus ID.

### 5.5 Glossary target language

Add `target_language` to `project_glossary_entries`.

Existing glossary rows backfill to `vi`.

Glossary uniqueness becomes target-aware. The logical uniqueness key is:

`(project_id, target_language, source_term_key, case_sensitive)`.

Translation style remains project-global in Phase 4C.

The translation-context revision stays a project-global coarse revision. A glossary change for any target increments the project context revision according to the existing Phase 4A trigger semantics; translation rows persist the exact revision used so stale context is visible and auditable.

### 5.6 Compatibility bridge

Do not remove in Phase 4C:

- `projects.target_language`;
- `projects.export_object_key`;
- `segments.translated_text`;
- existing segment translation engine/status compatibility fields.

Migration/backfill rules:

1. Every existing project gains enabled target `vi`.
2. Existing segment translated text is backfilled into `segment_translations(..., 'vi')`.
3. Existing project export object key is backfilled into a Vietnamese `dubbed` project export when present.
4. Existing glossary rows become target `vi`.
5. Vietnamese writes mirror the legacy compatibility fields while the legacy API remains supported.

This bridge exists for backward compatibility only; Phase 4C code must treat language-variant tables as the multi-language source of truth.

## 6. Target-language domain contract

Introduce one canonical target-language type shared by Worker domain/provider code:

```ts
export const TARGET_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'] as const;
export type TargetLanguage = typeof TARGET_LANGUAGES[number];
```

Remove target-specific `'vi'` type literals from new provider/domain interfaces. Existing compatibility DTOs may remain Vietnamese-only where intentionally preserved.

Project creation remains backward-compatible and defaults to `vi`; Phase 4C language configuration is managed through the target-language API after project creation.

## 7. Translation provider behavior

`TranslationProvider.translateBatch` accepts `TargetLanguage`.

Providers must expose or enforce target-language capability. A provider must never silently substitute Vietnamese or another target.

### 7.1 Google Cloud Translation

Map each supported target to the official Google Cloud Translation language code.

Request `target` must be the requested target language, not hard-coded Vietnamese.

Unsupported or unresolved targets fail with an explicit provider error.

### 7.2 Workers AI raw translation

Extend target-language mapping for `vi`, `en`, `zh`, `ja`, and `ko` where the configured translation model supports them.

If the selected model cannot support a requested target, fail closed with `TRANSLATION_TARGET_UNSUPPORTED`; do not fall back to Google or another target implicitly.

### 7.3 Contextual Workers AI

Contextual requests include the explicit requested target language in trusted instructions/payload boundaries.

Existing structural safety remains mandatory:

- JSON-only accepted result shape;
- exact request IDs;
- no missing/extra/duplicate/foreign IDs;
- bounded context payload;
- no partial persistence on malformed output.

### 7.4 Router

Inactive context routes according to the existing explicit/default raw-provider behavior.

Active context auto-routes to contextual translation exactly as Phase 4A does, now parameterized by target language.

`compare` is permitted only when every provider required by compare supports/configures the requested target. Otherwise return a capability error rather than a partial comparison.

## 8. Translation context by target

Glossary lookup becomes target-aware:

```ts
getContext(projectId, userId, targetLanguage)
```

The returned context contains:

- project-global style;
- glossary entries for the requested target only;
- exact project translation-context revision.

A target translation operation loads one immutable context snapshot before its internal batches begin.

If the project context changes while that target operation is running, already-started batches keep the original snapshot. A later target operation may load the newer revision.

Every persisted translation variant records the exact context revision used.

Changing glossary/style does not auto-rewrite existing translations. UI may show that a variant used an older context revision and offer explicit retranslation.

## 9. API surface

All endpoints are owner-scoped. A project not owned by the current actor returns the same not-found semantics used elsewhere rather than exposing cross-user existence.

### 9.1 Language configuration

`GET /api/projects/:id/languages`

Returns enabled targets, per-language status, and `languagesRevision` sourced from `projects.target_languages_revision`.

`PATCH /api/projects/:id/languages`

Body:

```json
{
  "targetLanguages": ["vi", "ja", "ko"],
  "expectedLanguagesRevision": 4
}
```

Stale update returns `409 PROJECT_LANGUAGES_CONFLICT` plus the canonical language configuration.

At least one target language must remain enabled. Duplicate/unsupported targets are rejected before mutation.

### 9.2 Translation variants

`GET /api/projects/:id/translations/:language`

Returns canonical source segment identity/timing plus target-specific translation rows.

`PATCH /api/projects/:id/translations/:language/:segmentId`

Uses `expectedVersion` optimistic concurrency. Stale edits return `409 TRANSLATION_VARIANT_CONFLICT` and the canonical variant.

`POST /api/projects/:id/translations/:language/:segmentId/retranslate`

Retranslates exactly one target variant from canonical source text.

`POST /api/projects/:id/translations/:language/process`

Runs or queues a target-language translation operation using one context snapshot for the entire target operation.

### 9.3 Export variants

`POST /api/projects/:id/exports/:language`

Body includes `output: 'dubbed' | 'subtitles'` and defaults to `dubbed` only for the legacy-compatible Vietnamese path; new Phase 4C clients must send it explicitly.

`GET /api/projects/:id/exports/:language?output=dubbed|subtitles`

Returns latest/current export state for that target/output mode.

`GET /api/projects/:id/exports/:language/media?output=dubbed|subtitles`

Streams the completed target-language artifact with owner telemetry and range behavior equivalent to the existing owner export endpoint where the artifact type supports ranges.

`POST /api/projects/:id/exports/batch`

Body:

```json
{
  "targetLanguages": ["vi", "ja", "ko"],
  "output": "dubbed"
}
```

`output` is exactly `dubbed` or `subtitles` for the entire batch request. A mixed dubbed/subtitle batch requires separate requests in Phase 4C.

The batch response exposes per-language durable state; it does not claim all-or-nothing success.

### 9.4 Legacy API

Existing Vietnamese endpoints remain functional during Phase 4C and map to target `vi` compatibility behavior.

Examples include the existing single-segment retranslate/export/download paths. New code must not break current frontend/API consumers solely because multi-language tables now exist.

## 10. Translation batch workflow

A multi-target request orchestrates target operations independently.

For each target:

1. authorize project;
2. load canonical source segments;
3. load one target-aware translation-context snapshot;
4. validate provider capability;
5. translate in bounded batches;
6. validate exact returned IDs;
7. record Phase 3B usage using source Unicode characters;
8. persist target translation rows with exact context revision;
9. mark target status for review/ready according to existing policy.

Targets do not share translated text or provider responses.

One target failure must not erase successful target results.

## 11. Usage accounting and telemetry

Do not introduce new usage kinds.

Continue using:

- `translation_character`;
- `tts_audio_second`;
- `render_second`.

A source string translated into three target languages represents three real translation provider operations and is metered three times.

Prompt instructions, glossary metadata, style names, and target metadata are not added to translation character units.

Operation keys include target language to prevent cross-language collisions:

```text
job:{jobId}:retry:{retry}:translation:{lang}:batch-{n}:{provider}
job:{jobId}:retry:{retry}:tts:{lang}:{segmentId}:{provider}
job:{jobId}:retry:{retry}:render:{lang}:final:ffmpeg-container
```

Subtitle-only export does not record TTS or render usage unless it actually invokes a metered render stage. If subtitle generation is pure serialization with no metered provider/container call, it creates no synthetic usage event.

Started/completed semantics and durable-artifact recovery remain compatible with Phase 3B.

Reused completed artifacts must not be double-metered.

Phase 3C provider telemetry remains in place around actual provider calls. Target language may be added as non-sensitive structured metadata where telemetry types permit it, but Phase 4C must not weaken existing redaction or admission ordering.

## 12. Language-aware TTS and export

TTS/export is parameterized by target language instead of duplicated into separate pipelines.

Language-specific voice artifacts use keys such as:

```text
projects/{projectId}/voices/{lang}/{segmentId}/{version}.mp3
```

Subtitles use immutable/versioned keys such as:

```text
projects/{projectId}/subtitles/{lang}/{exportId}.srt
```

Final dubbed exports use immutable/versioned keys under:

```text
projects/{projectId}/exports/{lang}/{exportId}.mp4
```

Vietnamese compatibility mirrors the latest completed Vietnamese dubbed export into `projects.export_object_key`.

### 12.1 Voice capability

Phase 4B already exposes voice capabilities including `languages`, `cloning`, and clone-enrollment capability. Phase 4C consumes that contract.

Before dubbed export:

- explicitly supported target language: proceed;
- explicitly unsupported target language: fail `VOICE_LANGUAGE_UNSUPPORTED`;
- unknown language capability: do not advertise dubbed export as qualified; fail `VOICE_LANGUAGE_UNQUALIFIED` for dubbed output.

Subtitle-only export is permitted when translations are ready even if voice language capability is unsupported or unknown.

Phase 4C does not create, enroll, delete, or otherwise mutate voice clones except through already-existing speaker/voice APIs needed by normal export.

## 13. Batch export semantics

A batch is not a single transaction over all languages.

Each target has durable independent status and artifacts.

For batch output `dubbed`, every target independently checks voice capability. For batch output `subtitles`, voice capability is irrelevant.

Example dubbed result:

```json
{
  "status": "partial",
  "languages": {
    "vi": { "status": "completed" },
    "ja": { "status": "failed", "errorCode": "VOICE_LANGUAGE_UNSUPPORTED" },
    "ko": { "status": "completed" }
  }
}
```

Successful artifacts survive failures in other languages.

Retrying one failed language reuses valid translations/TTS/export intermediates where their version/provenance still matches. It must not regenerate or charge successful languages again.

## 14. Invalidation rules

Source edit:

- marks every target translation variant for that source segment stale/pending rather than silently treating old translated text as current;
- invalidates dependent TTS and exports for those variants.

Target translation edit/retranslate:

- increments only that target variant version;
- invalidates only that target's TTS/export artifacts for the affected segment/version;
- does not change other language variants.

Speaker voice assignment change:

- invalidates affected dubbed voice/export artifacts according to existing speaker/voice dependency rules;
- does not invalidate translated text or subtitle-only exports.

Glossary/style change:

- increments/changes translation context revision as Phase 4A requires;
- does not automatically rewrite translations;
- makes old context revision visible so the user can explicitly retranslate.

Target-language disable:

- removes it from active project workflow/UI selection;
- does not physically delete historical translation/export rows in the same mutation;
- re-enabling the language may reuse still-valid history after source version/context/provenance checks.

## 15. Concurrency model

Use separate conflict domains.

### Project language set

`projects.target_languages_revision` guards enabled-target configuration.

Stale mutation returns `409 PROJECT_LANGUAGES_CONFLICT` with canonical current state.

### Translation variant

Each `(segment, target language)` row has its own `version`.

Stale mutation returns `409 TRANSLATION_VARIANT_CONFLICT` with canonical current variant.

### Translation context

Existing project translation-context revision remains separate and records glossary/style snapshot provenance.

Editing Japanese must not create a false conflict with Korean merely because another target changed.

## 16. Project aggregate status

Per-language status is the Phase 4C source of truth for multi-language UX.

Existing project status remains a coarse compatibility/dashboard aggregate:

- `processing` while any active language operation is running;
- `needs_review` when any enabled target requires review/intervention and no active operation needs the stronger `processing` state;
- `completed` only when all currently enabled targets required by the requested workflow scope are complete;
- `cancelled` follows existing explicit cancellation semantics;
- fatal project-wide failures may still use existing failure semantics.

Do not infer exact language state only from project status.

## 17. Studio UX

Add a Target Languages control near project/translation settings.

Supported labels are localized for Vietnamese UI while canonical API values remain language codes.

The Studio exposes language tabs/selector similar to:

```text
Source | Vietnamese | Japanese | Korean
```

Switching target language changes only target-specific translation/export state. Source timing, source text, speaker identity, player position, and segment selection stay canonical.

### 17.1 Translation editor

For the selected target show:

- translated text;
- translation status;
- context freshness/revision when useful;
- target-specific save/conflict state;
- explicit retranslate action.

No edit to one target implicitly rewrites another.

### 17.2 Glossary UI

Add target-language selection to glossary entries and filtering.

Users can maintain different preferred translations for the same source term per target.

Style preset remains project-global.

### 17.3 Export UI

Expose:

- `Export current language`;
- `Batch export selected languages`.

The batch dialog requires one output mode for the request: `Dubbed video` or `Subtitles only`.

Show one durable row per selected target with statuses such as:

```text
Vietnamese    Ready        Export
Japanese      Translating  —
Korean        Failed       Retry
```

Never show batch complete when only a subset succeeded.

UI must distinguish translation/subtitle readiness from dubbed-audio readiness when voice capability is unsupported or unqualified.

## 18. Error model

Phase 4C introduces explicit errors including:

- `TARGET_LANGUAGE_UNSUPPORTED`;
- `PROJECT_LANGUAGES_CONFLICT`;
- `TRANSLATION_VARIANT_NOT_FOUND`;
- `TRANSLATION_VARIANT_CONFLICT`;
- `TRANSLATION_LANGUAGE_NOT_READY`;
- `VOICE_LANGUAGE_UNSUPPORTED`;
- `VOICE_LANGUAGE_UNQUALIFIED`;
- `LANGUAGE_EXPORT_NOT_READY`;
- `BATCH_EXPORT_PARTIAL` where a summary/error surface requires a batch-level code.

Provider-specific existing errors remain intact.

Errors returned to users must not expose provider credentials, prompts, glossary content beyond the user's own requested canonical payload, or other sensitive metadata.

## 19. Rate limits and authorization

All expensive multi-language routes keep Phase 3C admission ordering:

1. parse/validate route/body inputs;
2. authorize project/segment ownership;
3. enforce optimistic-concurrency preconditions where applicable;
4. apply expensive-operation rate limit;
5. call provider/workflow.

Batch operations are rate-limited as expensive operations and must not be used to bypass per-user/project safeguards.

No provider call occurs before authorization and relevant input/version validation.

## 20. Source compatibility and reconciliation with Phase 4B

The spec baseline already includes Phase 4B safe voice clone enrollment.

Phase 4C must preserve:

- explicit consent enrollment;
- durable clone lifecycle;
- provider compensation/deletion rules;
- ready-only speaker voice assignment;
- clone abuse controls;
- truthful capability reporting.

Multi-language export only asks whether the selected voice/provider is qualified for the requested target language and uses existing voice IDs through normal generation APIs.

If Phase 4B code changes before Phase 4C merge, reconcile by preserving Phase 4B safety semantics first and adapting Phase 4C capability consumption to the live contract.

## 21. TDD and implementation slices

Implementation proceeds in explicit RED → GREEN slices.

1. `0009_multilanguage_variants.sql` schema/backfill/compatibility tests.
2. Target-language domain/provider capability contract.
3. `segment_translations` repository, optimistic versions, invalidation primitives.
4. Target-aware glossary/context repository and routes.
5. Target-language translation/retranslate routes.
6. Multi-language translation workflow and Phase 3B usage accounting.
7. `project_exports` repository and per-language export routes.
8. Language-aware TTS/export pipeline and artifact recovery.
9. Batch export orchestration and partial/retry semantics.
10. Frontend project/translation/export APIs.
11. Studio target-language switcher, glossary target field, variant editor, batch export UI.
12. Source acceptance guard, documentation, full CI, PR reconciliation, merge, and post-merge CI.

Do not combine RED and GREEN evidence into a single unobservable step when a behavior can be isolated.

## 22. Acceptance criteria

Phase 4C is source/CI-qualified only when all of the following are covered and pass on the exact candidate head:

1. Existing Vietnamese projects migrate without data loss and continue to work through legacy paths.
2. Canonical source segment IDs/timing/speaker state are not duplicated per target language.
3. Editing/retranslating one target does not mutate another target.
4. Stale language-set updates return canonical `409 PROJECT_LANGUAGES_CONFLICT`.
5. Stale translation edits return canonical `409 TRANSLATION_VARIANT_CONFLICT`.
6. Glossary entries apply only to their target language.
7. Translation style remains project-global.
8. One immutable context snapshot is used for each target translation operation.
9. Persisted translation rows record exact context revision and provider provenance.
10. All targets translate from canonical source text, never from another target translation.
11. Translation usage meters source Unicode characters once per actual target/provider operation.
12. TTS/render usage is not double-counted when durable artifacts are reused.
13. Operation keys cannot collide across target languages.
14. Subtitle-only export does not fabricate TTS/render usage when those metered stages are not invoked.
15. One failed batch language does not erase successful languages or their artifacts.
16. Retrying a failed language does not regenerate/rebill successful languages.
17. Voice capability is fail-closed for dubbed export and truthful in UI.
18. Subtitle-only export remains available when translation is ready and does not pretend dubbed-audio support.
19. Legacy Vietnamese export/download remains functional during compatibility period.
20. Phase 3C authorization, rate-limit ordering, telemetry, sharing/download safety, and redaction tests remain green.
21. Phase 4A glossary/style/context semantics remain green.
22. Speaker stitching/project-stable diarization tests remain green.
23. Phase 4B voice-clone consent/lifecycle/assignment/abuse-control tests remain green.
24. TypeScript, Vite production build, Wrangler dry-run, CJK screenshot qualification, reference screenshots, and artifact upload remain green.
25. Post-merge CI on the actual `main` merge SHA succeeds before the lane is called complete.

## 23. Deployment status

Phase 4C does not deploy production.

Passing source tests, build, Wrangler dry-run, screenshots, PR CI, and post-merge CI qualifies repository source only.

Production remains unqualified until Cloudflare runtime/container credentials and real provider/media fixtures—including target-language translation, target-language TTS capability, and multi-language export artifacts—are exercised in the approved runtime qualification lane.

## 24. Merge safety

The repository is being changed by multiple agents/branches.

Before any write that depends on branch ancestry and before PR merge:

- re-fetch live feature head;
- re-fetch live `main`;
- never force push;
- detect changed-path overlap with newly merged lanes;
- reconcile live behavior semantically, not by blindly selecting one side;
- rerun fresh exact-head CI after reconciliation;
- merge only with expected-head semantics;
- verify post-merge CI on the actual merge SHA.

Migration numbering is part of this reconciliation rule.
