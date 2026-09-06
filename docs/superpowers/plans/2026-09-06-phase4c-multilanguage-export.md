# Phase 4C Multi-language Export Implementation Plan

> **Execution:** use superpowers TDD + executing-plans. The user approved implementation of all remaining Phase 4 lanes; no additional design confirmation is required. Keep exact-head CI checkpoints, no force pushes, and source/CI qualification only.

**Goal:** Extend one YupVox project from a single Vietnamese target into independent `vi/en/zh/ja/ko` translation, subtitle, TTS, and export variants while preserving one canonical source transcript/timing/speaker graph and all Phase 3B–4B safety contracts.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4c-multilanguage-export-design.md`

**Baseline at plan creation:** Phase 4B merge main `e2c81f00ff195a66661d4e651f0316820f7aa7c8`. Before implementation mutations, refresh from live `main` if the Phase 4B mount-guard follow-up or another lane advances main.

## Global invariants

- Supported targets are exactly `vi`, `en`, `zh`, `ja`, `ko`.
- `segments` remains canonical source/timing/speaker identity. Never clone source segments per target.
- New variant tables are authoritative for multi-language state; Vietnamese legacy fields remain a compatibility mirror.
- Every provider translation starts from canonical `sourceText`, never another target translation.
- Phase 3B usage kinds remain unchanged; target language enters operation identity to avoid collisions.
- Phase 3C authorization/admission/telemetry/share safety must remain green.
- Phase 4A context + project-stable diarization and Phase 4B explicit-consent voice-clone contracts must remain green.
- Production deployment remains manual-only and runtime **UNQUALIFIED**.

---

## Task 1 — Schema, backfill, and source acceptance

**Files**
- Create: `migrations/0009_multilanguage_variants.sql` (renumber if live main consumes 0009 first)
- Create: `tests/phase4c-multilanguage-acceptance.test.mjs`
- Modify: `package.json`
- Modify as required: `worker/src/db/projects.ts`, migration/readiness tests

**RED first**
- Acceptance requires `projects.target_languages_revision >= 1`.
- `project_target_languages` unique `(project_id,target_language)` with exact target/status enums.
- `segment_translations` unique `(segment_id,target_language)` with version/provenance/context revision.
- `project_exports` immutable ID + project/language/output mode and deterministic latest lookup fields.
- glossary rows gain target language and target-aware uniqueness.
- migration backfills every existing project with `vi`, Vietnamese translation compatibility rows, existing dubbed export, and existing glossary rows.
- Add acceptance to `verify:deploy-config` and observe RED before migration exists.

**GREEN**
- Implement migration/backfill without deleting legacy columns.
- Add project repository support for target-language revision without changing legacy project DTO behavior.
- Require fresh exact-head full CI before Task 2.

## Task 2 — Canonical target-language domain + provider capability

**Files**
- Create: `worker/src/domain/target-language.ts`
- Modify: `worker/src/services/translation/types.ts`
- Modify: `worker/src/services/translation/google.ts`
- Modify: `worker/src/services/translation/workers-ai.ts`
- Modify: `worker/src/services/translation/contextual.ts`
- Modify: `worker/src/services/translation/router.ts`
- Modify voice capability types/providers only as needed to expose truthful supported/unknown target languages
- Tests: translation provider/router/capability suites

**RED first**
- Exact canonical target set.
- Google request target reflects requested language.
- Workers AI/contextual target prompt/payload reflects requested language.
- Unsupported target fails `TRANSLATION_TARGET_UNSUPPORTED`; no silent target/provider substitution.
- Compare rejects when required providers cannot support target.

**GREEN**
- Parameterize existing providers/router; preserve inactive/active context routing semantics.
- Do not change billing units or clone behavior.

## Task 3 — Language-set repository + API concurrency

**Files**
- Create: `worker/src/db/project-languages.ts`
- Create: `worker/src/routes/languages.ts`
- Modify: `worker/src/app.ts`
- Tests: `worker/test/project-languages.test.ts`, `worker/test/language-routes.test.ts`

**RED first**
- GET owner-scoped language set/status/revision.
- PATCH validates all targets before mutation, rejects duplicate/unsupported/empty set.
- stale revision -> `409 PROJECT_LANGUAGES_CONFLICT` with canonical current state.
- enabled-set mutation increments project revision exactly once; status-only writes do not.
- disabled target history is retained, not deleted.

**GREEN**
- Implement transaction-safe repository and mount route.
- Keep project coarse status separate from exact per-language state.

## Task 4 — Segment translation variants + target-aware glossary/context

**Files**
- Create: `worker/src/db/segment-translations.ts`
- Modify: `worker/src/db/translation-context.ts`
- Modify: `worker/src/routes/translation-context.ts`
- Modify glossary/settings route/repository tests
- Tests: new variant/context suites

**RED first**
- Variant CRUD/version keyed by `(segment,target)`.
- stale edit -> `409 TRANSLATION_VARIANT_CONFLICT` with canonical row.
- editing `ja` cannot mutate/conflict with `ko`.
- glossary is filtered by requested target; style remains global.
- one immutable context snapshot carries exact global context revision.
- Vietnamese variant writes mirror legacy segment translation fields.

**GREEN**
- Implement repository + target-aware context lookup.
- Existing Phase 4A tests remain unchanged/green unless assertions must explicitly include default `vi`.

## Task 5 — Target-language translation/retranslate routes

**Files**
- Create/extend: `worker/src/routes/translations.ts` or current translation route with new language-scoped endpoints
- Modify: `worker/src/app.ts`
- Tests: route/version/admission suites

**RED first**
- GET language variants combines canonical source identity/timing with target row.
- PATCH optimistic version is per target.
- retranslate validates route/body -> ownership -> version/context/provider capability -> translate limiter -> provider.
- provider input is canonical source text.
- target-specific persistence records provider + exact context revision.
- legacy Vietnamese retranslate remains functional.

**GREEN**
- Reuse existing telemetry/rate limiter/provider router; do not fork security behavior.

## Task 6 — Multi-language translation operation + usage accounting

**Files**
- Create: `worker/src/workflows/translationPipeline.ts` or language-operation service appropriate to current Workflow architecture
- Modify Workflow bindings/routes only if durable orchestration requires it
- Tests: target operation, partial failures, usage keys

**RED first**
- Each target gets independent context snapshot/result/failure.
- no target translation chaining.
- source Unicode character units recorded once per real target/provider operation.
- operation key contains target language.
- retry does not duplicate completed usage `(operation_key,phase)`.
- one target failure preserves other target results.

**GREEN**
- Parameterize batching; preserve provider telemetry redaction.
- Require exact-head full CI checkpoint after Tasks 1–6.

## Task 7 — Project export repository + subtitle serialization

**Files**
- Create: `worker/src/db/project-exports.ts`
- Create: `worker/src/services/subtitles/srt.ts`
- Tests: repository/SRT safety

**RED first**
- immutable export IDs with deterministic latest per `(project,target,output)`.
- subtitle export uses target translation rows + canonical timing.
- SRT output escapes/normalizes deterministically and uses immutable key `projects/{project}/subtitles/{lang}/{exportId}.srt`.
- subtitle-only serialization creates no synthetic TTS/render usage.
- Vietnamese completed dubbed export mirrors legacy `projects.export_object_key` only.

**GREEN**
- Implement repository and pure SRT serializer.

## Task 8 — Language-aware TTS/render export pipeline

**Files**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/routes/export.ts`
- Modify media/voice interfaces only as necessary
- Tests: export pipeline/usage/recovery/voice capability

**RED first**
- target language parameter controls translation rows, voice capability, object keys and export row.
- dubbed output fails closed on explicitly unsupported (`VOICE_LANGUAGE_UNSUPPORTED`) or unknown (`VOICE_LANGUAGE_UNQUALIFIED`) capability.
- subtitle output ignores voice capability.
- voice keys include language; render operation keys include language.
- durable TTS/render artifacts are reused without double metering.
- existing Vietnamese export path still works.

**GREEN**
- Parameterize existing pipeline rather than clone it.
- Keep Phase 4B clone IDs as ordinary assigned voice IDs; no clone lifecycle mutations.

## Task 9 — Language export API, Range streaming, and batch orchestration

**Files**
- Create/extend language-scoped export routes
- Reuse: `worker/src/http/media-stream.ts`
- Tests: per-language export/media/batch/partial retry

**RED first**
- POST/GET/media routes are owner scoped and output-mode explicit for new clients.
- completed MP4/SRT artifacts stream from current export row; MP4 preserves Range 200/206/416 parity.
- batch has independent per-target states; one failure -> partial, successful artifacts survive.
- retry failed target does not invoke successful targets/providers again.
- batch cannot bypass admission limits.

**GREEN**
- Implement thin orchestration around target-specific translation/export services.

## Task 10 — Frontend APIs/state for target variants

**Files**
- Create: `src/features/languages/languageApi.ts`
- Create: `src/features/transcript/translationVariantApi.ts`
- Create: `src/features/export/languageExportApi.ts` (or current export feature path)
- Modify hydration/state adapters carefully; canonical source/timing remains single-copy
- Tests for API error/version/partial response handling

**RED first**
- stable API errors/conflict canonical payloads.
- language switch does not reset source selection/timing/player.
- no reconstruction of target data from legacy fields except Vietnamese compatibility fallback explicitly tested.

## Task 11 — Studio language/glossary/editor/batch UI

**Files**
- Modify: `src/app/StudioShell.tsx`
- Modify transcript/glossary/export components
- Add focused UI components/tests as needed

**RED first**
- target selector supports exactly five canonical values but only enabled targets appear as project tabs.
- selected target changes target translation/export state only.
- glossary entry requires/filters target; style remains global.
- batch dialog has one output mode and selected target set.
- rows show independent translating/ready/failed/retry state; never claim all complete on partial success.
- dubbed action disabled/truthful when voice target unsupported/unqualified; subtitles remain available when ready.

**GREEN**
- Keep existing workstation geometry/reference fidelity; no redesign.

## Task 12 — Acceptance, docs, exact-head integration

**Files**
- Expand: `tests/phase4c-multilanguage-acceptance.test.mjs`
- Modify: `docs/deployment-status.md`, `README.md`
- Update prior source guards only when live behavior legitimately expands them; never weaken prior safety semantics.

**Verification**
- `npm run verify`
- `npx wrangler deploy --dry-run`
- exact-head CI must pass verify/build, Wrangler, CJK screenshot, reference screenshots, artifact upload.
- self-review all changed files for Critical/Important issues.
- re-fetch live `main`; reconcile migration number and changed-path overlap non-force.
- open PR to `main`; require fresh PR-trigger exact-head CI GREEN.
- check review threads + mergeability + live main/head race.
- merge with `expected_head_sha` and method `merge`.
- require post-merge push CI FULL GREEN on actual merge SHA.
- do **not** trigger production deployment; docs continue to state production runtime **UNQUALIFIED**.
