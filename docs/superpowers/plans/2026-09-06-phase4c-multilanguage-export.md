# Phase 4C Batch + Multi-language Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-level Vietnamese/English/Chinese/Japanese/Korean translation, subtitle, TTS, and export variants without duplicating canonical source segments or weakening existing usage, telemetry, speaker, or voice-clone guarantees.

**Architecture:** Keep `segments` as the canonical source/timing/speaker graph and add target-language variant tables for enabled languages, translated text/TTS, and exports. Preserve Vietnamese legacy columns/routes as a compatibility mirror while new owner-scoped repositories/routes/workflows operate on `(project, targetLanguage)` variants with independent optimistic concurrency and fail-closed provider/voice capabilities.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Hono, Cloudflare Workers/Workflows/D1/R2/Containers, Vitest, Node test runner, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4c-multilanguage-export-design.md`

## Global Constraints

- Supported Phase 4C targets are exactly `vi`, `en`, `zh`, `ja`, `ko`.
- Every target translation originates from canonical `segments.source_text`; never translate target-to-target.
- Canonical segment IDs, source text, timing, split lineage, and speaker identity remain in `segments`.
- `projects.target_language`, `projects.export_object_key`, and Vietnamese translation fields on `segments` remain during Phase 4C as compatibility mirrors.
- The branch baseline contains `0008_voice_clones.sql`; reserve `0009_multilanguage_variants.sql`, but re-check migration numbering against live `main` before merge.
- Translation context remains project-global by revision but glossary lookup is target-aware.
- One target translation operation uses one immutable context snapshot across all internal batches.
- Usage kinds stay exactly `translation_character`, `tts_audio_second`, and `render_second`; source Unicode characters are metered once per actual target/provider translation operation.
- Reused durable artifacts never create duplicate completed usage.
- Phase 3C rate-limit ordering, redaction, telemetry, sharing, and owner-scoped not-found semantics must remain intact.
- Phase 4A speaker stitching/diarization and Phase 4B voice-clone enrollment must not be forked or weakened.
- Dubbed export is fail-closed when voice language support is unsupported or unknown; subtitle-only output may proceed without TTS.
- No production deployment in this lane. Source/CI qualification does not imply runtime qualification.
- Every task uses RED -> exact-head CI evidence -> minimal GREEN -> exact-head CI before the next task.
- Never force-push. Re-fetch live branch and `main` before each ref update and before merge.

---

## File Structure Map

### New backend files

- `worker/src/domain/language.ts` — canonical `TargetLanguage`, labels, validation, export-output type.
- `worker/src/db/project-languages.ts` — enabled target set, project-level `target_languages_revision`, per-language status.
- `worker/src/db/segment-translations.ts` — target translation/TTS rows and optimistic versioning.
- `worker/src/db/project-exports.ts` — per-language/output export attempts and durable batch grouping.
- `worker/src/routes/languages.ts` — owner-scoped target-language configuration API.
- `worker/src/routes/translation-variants.ts` — list/edit/retranslate/process target translation variants.
- `worker/src/workflows/languageTranslationPipeline.ts` — translate canonical segments into one target using one context snapshot.
- `worker/src/workflows/LanguageTranslationWorkflow.ts` — Cloudflare Workflow adapter for target translation.
- `worker/src/services/subtitles/srt.ts` — deterministic SRT serialization from canonical timings + target text.

### Existing backend files to modify

- `migrations/0009_multilanguage_variants.sql` — variant schema/backfill.
- `worker/src/db/projects.ts` — expose `targetLanguagesRevision`; preserve legacy target/export mirrors.
- `worker/src/db/segments.ts` — source-edit/split/restore invalidation and Vietnamese compatibility mirror.
- `worker/src/db/translation-context.ts` — target-aware glossary/context access.
- `worker/src/services/translation/context.ts` — target language on glossary/context DTOs.
- `worker/src/services/translation/types.ts` — provider target capability.
- `worker/src/services/translation/language-map.ts` — target maps.
- `worker/src/services/translation/workers-ai.ts` — non-Vietnamese targets.
- `worker/src/services/translation/google.ts` — dynamic Google target.
- `worker/src/services/translation/contextual.ts` — explicit target in contextual prompt/payload.
- `worker/src/services/translation/router.ts` — `TargetLanguage` routing/capability checks.
- `worker/src/routes/translation-context.ts` — target-aware glossary API with `vi` default compatibility.
- `worker/src/routes/translation.ts` — legacy single-segment route explicitly maps to `vi`.
- `worker/src/routes/export.ts` — per-language/output routes, batch launch, legacy `vi` wrapper.
- `worker/src/services/media/types.ts` — language/export identity render options.
- `worker/src/services/media/container.ts` — language-scoped immutable export key contract.
- `worker/src/workflows/exportPipeline.ts` — generic target/output export pipeline.
- `worker/src/workflows/ExportWorkflow.ts` — target/output/export ID params.
- `worker/src/workflows/DubbingWorkflow.ts` and `worker/src/workflows/pipeline.ts` — keep default full dubbing path Vietnamese-compatible through variant repository.
- `worker/src/env.ts`, `worker/src/index.ts`, `wrangler.jsonc` — language-translation Workflow binding/class.
- `worker/src/app.ts` — mount new routes.

### New frontend files

- `src/features/translation/languageVariantsApi.ts` — language config + translation variant client.
- `src/features/translation/TargetLanguagesPanel.tsx` — target set/status/current-language controls.
- `src/features/export/batchExportApi.ts` — per-language/batch export client.
- `src/features/export/BatchExportPanel.tsx` — current/batch output controls and partial statuses.
- `src/features/export/batch-export.css` — scoped export panel styles.

### Existing frontend files to modify

- `src/features/translation/translationSettingsApi.ts` — glossary target language.
- `src/features/translation/TranslationSettingsPanel.tsx` — target selector for glossary entries.
- `src/features/translation/translation-settings.css` — target UI styling.
- `src/app/StudioShell.tsx` — current target state, language panel, batch export panel, and target-specific transcript plumbing.
- `src/styles/studio.css` — minimal shell layout additions only if scoped feature CSS cannot cover them.

### Acceptance/docs

- `tests/phase4c-multilanguage-export-acceptance.test.mjs` — static/source architecture guard.
- `package.json` — wire Phase 4C acceptance into `verify:deploy-config`.
- `docs/deployment-status.md` — source-qualified/runtime-unqualified state.

---

### Task 1: Multi-language Schema, Backfill, and Canonical Target Domain

**Files:**
- Create: `migrations/0009_multilanguage_variants.sql`
- Create: `worker/src/domain/language.ts`
- Create: `worker/test/multilanguage-migration.test.ts`
- Modify: `worker/src/db/projects.ts`

**Interfaces:**
- Produces: `TargetLanguage`, `TARGET_LANGUAGES`, `isTargetLanguage`, `ExportOutput`, `ProjectLanguageStatus`.
- Produces database tables: `project_target_languages`, `segment_translations`, `project_exports`.
- Produces project field: `targetLanguagesRevision: number` mapped from `projects.target_languages_revision`.

- [ ] **Step 1: Write the failing migration/domain tests**

```ts
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('defines the five canonical Phase 4C target languages', async () => {
  const language = await import('../src/domain/language');
  expect(language.TARGET_LANGUAGES).toEqual(['vi', 'en', 'zh', 'ja', 'ko']);
  expect(language.isTargetLanguage('ja')).toBe(true);
  expect(language.isTargetLanguage('fr')).toBe(false);
});

it('creates language variant tables and Vietnamese backfills', () => {
  const sql = readFileSync('migrations/0009_multilanguage_variants.sql', 'utf8');
  expect(sql).toContain('ADD COLUMN target_languages_revision');
  expect(sql).toContain('CREATE TABLE project_target_languages');
  expect(sql).toContain('CREATE TABLE segment_translations');
  expect(sql).toContain('CREATE TABLE project_exports');
  expect(sql).toContain("SELECT id, 'vi'");
  expect(sql).toContain("target_language TEXT NOT NULL DEFAULT 'vi'");
});
```

- [ ] **Step 2: Run the focused RED test**

Run: `npx vitest run worker/test/multilanguage-migration.test.ts`

Expected: FAIL because `worker/src/domain/language.ts` and `migrations/0009_multilanguage_variants.sql` do not exist.

- [ ] **Step 3: Push the test-only commit and verify exact-head RED CI**

```bash
git add worker/test/multilanguage-migration.test.ts
git commit -m "test: define Phase 4C variant schema contract"
git push origin feat/phase4c-multilanguage-export
```

Expected exact-head CI: existing suites pass; only new Phase 4C schema/domain expectations fail.

- [ ] **Step 4: Implement canonical target types**

```ts
export const TARGET_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export const TARGET_LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  vi: 'Vietnamese',
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

export type ExportOutput = 'dubbed' | 'subtitles';
export type ProjectLanguageStatus =
  | 'pending'
  | 'translating'
  | 'needs_review'
  | 'ready'
  | 'exporting'
  | 'completed'
  | 'failed';

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string'
    && (TARGET_LANGUAGES as readonly string[]).includes(value);
}
```

- [ ] **Step 5: Implement the migration with compatibility backfill**

Use this schema shape:

```sql
ALTER TABLE projects ADD COLUMN target_languages_revision INTEGER NOT NULL DEFAULT 1
  CHECK (target_languages_revision >= 1);

CREATE TABLE project_target_languages (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','translating','needs_review','ready','exporting','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, target_language)
);

CREATE TABLE segment_translations (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  translated_text TEXT NOT NULL DEFAULT '',
  translation_engine TEXT NOT NULL DEFAULT 'workers-ai',
  translation_status TEXT NOT NULL DEFAULT 'pending',
  translation_context_revision INTEGER,
  voice_status TEXT NOT NULL DEFAULT 'pending',
  dubbed_object_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, target_language)
);

CREATE TABLE project_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  output TEXT NOT NULL CHECK (output IN ('dubbed','subtitles')),
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','exporting','completed','failed','invalidated')),
  export_object_key TEXT,
  subtitle_object_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Also:
- `ALTER TABLE project_glossary_entries ADD COLUMN target_language TEXT NOT NULL DEFAULT 'vi' CHECK (target_language IN ('vi','en','zh','ja','ko'))`;
- drop/recreate `idx_project_glossary_unique` with `(project_id,target_language,source_term_key,case_sensitive)`;
- recreate glossary update revision trigger so changing `target_language` increments `translation_context_revision`;
- backfill one `vi` target row per project;
- backfill one `vi` `segment_translations` row per existing segment;
- backfill `projects.export_object_key` into a deterministic legacy Vietnamese export row when non-null;
- add indexes for project/language translation and latest project export lookup.

- [ ] **Step 6: Update project mapping**

Add `targetLanguagesRevision` to `Project`, `ProjectRow`, `PROJECT_COLUMNS`, and `fromRow`, without changing current `targetLanguage: 'vi'` compatibility DTO behavior.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
npx vitest run worker/test/multilanguage-migration.test.ts
npm run typecheck
npm run verify
```

Expected: PASS.

- [ ] **Step 8: Commit and push GREEN**

```bash
git add migrations/0009_multilanguage_variants.sql worker/src/domain/language.ts worker/src/db/projects.ts worker/test/multilanguage-migration.test.ts
git commit -m "feat: add multi-language variant schema"
git push origin feat/phase4c-multilanguage-export
```

Verify exact-head CI FULL GREEN before Task 2.

---

### Task 2: Language/Translation/Export Repositories and Invalidation

**Files:**
- Create: `worker/src/db/project-languages.ts`
- Create: `worker/src/db/segment-translations.ts`
- Create: `worker/src/db/project-exports.ts`
- Create: `worker/test/project-languages.test.ts`
- Create: `worker/test/segment-translations.test.ts`
- Create: `worker/test/project-exports.test.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/test/export-invalidation.test.ts`

**Interfaces:**

```ts
export type ProjectLanguageConfig = {
  revision: number;
  languages: { targetLanguage: TargetLanguage; status: ProjectLanguageStatus }[];
};

export interface ProjectLanguageStore {
  getConfig(projectId: string, userId: string): Promise<ProjectLanguageConfig | null>;
  updateEnabled(projectId: string, userId: string, expectedRevision: number, targets: TargetLanguage[]): Promise<ProjectLanguageConfig>;
  setStatus(projectId: string, userId: string, target: TargetLanguage, status: ProjectLanguageStatus): Promise<void>;
}

export interface SegmentTranslationStore {
  list(projectId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation[]>;
  get(projectId: string, segmentId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation | null>;
  updateText(projectId: string, segmentId: string, userId: string, target: TargetLanguage, expectedVersion: number, text: string): Promise<SegmentTranslation>;
  setTranslationResult(projectId: string, segmentId: string, userId: string, target: TargetLanguage, text: string, engine: 'workers-ai' | 'google', contextRevision: number | null): Promise<SegmentTranslation>;
  setVoiceResult(projectId: string, segmentId: string, userId: string, target: TargetLanguage, objectKey: string): Promise<void>;
  invalidateForSourceSegment(projectId: string, segmentId: string, userId: string): Promise<void>;
}
```

- [ ] **Step 1: Write RED repository tests**

Lock these behaviors:
- default project config contains only `vi`;
- language update requires exact `target_languages_revision` and at least one unique supported target;
- stale language update throws `PROJECT_LANGUAGES_CONFLICT` carrying canonical config;
- JA edit increments JA version only;
- VI edit mirrors legacy `segments.translated_text` and voice invalidation fields;
- target translation result stores exact context revision;
- source edit marks every target variant pending, clears target voice keys, and invalidates all project exports;
- target translation edit invalidates only same-language exports/TTS;
- export repository finds latest by `(project,target,output)` and supports `batchId`.

Example:

```ts
await translations.updateText('p1', 's1', 'u1', 'ja', 2, '新しい訳');
expect((await translations.get('p1', 's1', 'u1', 'ja'))?.version).toBe(3);
expect((await translations.get('p1', 's1', 'u1', 'vi'))?.version).toBe(2);
```

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npx vitest run worker/test/project-languages.test.ts worker/test/segment-translations.test.ts worker/test/project-exports.test.ts worker/test/export-invalidation.test.ts`

Expected: new repositories/modules missing; old invalidation test remains green.

- [ ] **Step 3: Push test-only RED commit and exact-head CI**

Commit message: `test: define multi-language persistence contracts`.

- [ ] **Step 4: Implement `ProjectLanguageRepository`**

Use owner-scoped project existence checks and a compare-and-swap project update:

```sql
UPDATE projects
SET target_languages_revision = target_languages_revision + 1,
    updated_at = datetime('now')
WHERE id = ? AND user_id = ? AND target_languages_revision = ?;
```

Only after the CAS succeeds, reconcile `project_target_languages` in a D1 batch. Never delete historical translation/export rows when disabling a language.

- [ ] **Step 5: Implement `SegmentTranslationRepository`**

Rules:
- all reads join/authorize through `projects.user_id`;
- `updateText` requires positive `expectedVersion` and uses `WHERE version = ?`;
- target edit clears target `voice_status/dubbed_object_key` and invalidates target exports;
- `vi` writes mirror legacy segment translation fields;
- provider result upsert does not overwrite a newer editor version silently.

- [ ] **Step 6: Implement `ProjectExportRepository`**

Required methods:

```ts
create(projectId, userId, targetLanguage, output, batchId?): Promise<ProjectExport>
latest(projectId, userId, targetLanguage, output): Promise<ProjectExport | null>
complete(projectId, exportId, userId, objectKeys): Promise<ProjectExport>
fail(projectId, exportId, userId, code, message): Promise<ProjectExport>
invalidateTarget(projectId, userId, targetLanguage): Promise<void>
invalidateAll(projectId, userId): Promise<void>
listBatch(projectId, userId, batchId): Promise<ProjectExport[]>
```

- [ ] **Step 7: Integrate source/timing/split invalidation in `SegmentRepository`**

Distinguish `sourceChanged` from target translation/speaker changes. Source edits invalidate all translation variants. Timing/speaker changes invalidate all dubbed outputs without rewriting target translation text. Split/restore must keep canonical source atomics and synchronize existing language rows inside the same D1 batch; use `splitTextAtRatio` for each existing target translation so Vietnamese compatibility behavior does not regress.

- [ ] **Step 8: Run focused + full verification and commit GREEN**

Run:

```bash
npx vitest run worker/test/project-languages.test.ts worker/test/segment-translations.test.ts worker/test/project-exports.test.ts worker/test/export-invalidation.test.ts
npm run verify
```

Commit: `feat: add language variant persistence`.

Verify exact-head CI FULL GREEN.

---

### Task 3: Multi-target Translation Provider Contract and Router

**Files:**
- Modify: `worker/src/services/translation/types.ts`
- Modify: `worker/src/services/translation/language-map.ts`
- Modify: `worker/src/services/translation/workers-ai.ts`
- Modify: `worker/src/services/translation/google.ts`
- Modify: `worker/src/services/translation/contextual.ts`
- Modify: `worker/src/services/translation/router.ts`
- Modify: `worker/test/translation-router.test.ts`
- Modify: `worker/test/contextual-translation.test.ts`
- Modify: existing provider-specific translation tests in `worker/test/`

**Interfaces:**

```ts
export type TranslationProviderCapabilities = {
  contextual: boolean;
  available: boolean;
  targets: readonly TargetLanguage[];
};

translateBatch(
  items: TranslationItem[],
  source: SourceLanguage,
  target: TargetLanguage,
  context?: TranslationContext,
): Promise<TranslationResult[]>;
```

- [ ] **Step 1: Add failing provider/router tests**

Test all five targets and explicit failure:

```ts
expect(await router.translate('google', items, 'en', 'ja')).toMatchObject({ mode: 'google' });
await expect(router.translate('workers-ai', items, 'en', 'fr' as never))
  .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
```

Google request assertion must inspect request JSON and require `target: 'ja'` for JA.

Contextual test must assert the trusted instruction/user payload names the requested target and still rejects missing/extra IDs.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run worker/test/translation-router.test.ts worker/test/contextual-translation.test.ts`

Expected: compile/runtime failure because provider interfaces accept only `'vi'` and capabilities lack `targets`.

- [ ] **Step 3: Implement target maps/capabilities**

```ts
export const WORKERS_AI_TARGET: Record<TargetLanguage, string> = {
  vi: 'vietnamese',
  en: 'english',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
};
```

Google target codes are the canonical codes themselves. Provider capability arrays must contain the exact supported targets.

- [ ] **Step 4: Update router target enforcement**

Add one helper:

```ts
function assertTarget(provider: TranslationProvider, target: TargetLanguage) {
  if (!provider.capabilities.targets.includes(target)) {
    throw new TranslationProviderError('TRANSLATION_TARGET_UNSUPPORTED', `Provider does not support target ${target}.`);
  }
}
```

Call it before each provider invocation; `compare` must validate both providers before starting either request.

- [ ] **Step 5: Preserve legacy Vietnamese behavior**

Existing callers that pass `'vi'` must return the same modes/provider labels and Phase 4A context rules as before.

- [ ] **Step 6: Verify and commit GREEN**

Run: `npm run verify`.

Commit: `feat: support multi-target translation providers`.

Verify exact-head CI FULL GREEN.

---

### Task 4: Target-aware Glossary and Translation Context

**Files:**
- Modify: `worker/src/services/translation/context.ts`
- Modify: `worker/src/db/translation-context.ts`
- Modify: `worker/src/routes/translation-context.ts`
- Modify: `worker/src/routes/translation.ts`
- Create: `worker/test/translation-context-language.test.ts`
- Modify: `worker/test/translation-router.test.ts`
- Modify: `src/features/translation/translationSettingsApi.test.ts`

**Interfaces:**

```ts
export type GlossaryEntry = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  sourceTerm: string;
  preferredTranslation: string;
  note: string | null;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
};

getContext(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<TranslationContext | null>;
```

- [ ] **Step 1: Write RED target-glossary tests**

Test:
- `getContext(...,'ja')` returns only JA glossary entries but the project-global style/revision;
- same canonical source term may exist once in VI and once in JA;
- duplicate same-target canonical source term still conflicts;
- legacy `GET /:id/glossary` defaults to VI;
- `?targetLanguage=ja` scopes reads;
- create/update accepts a validated target language;
- legacy retranslate route explicitly loads VI context.

- [ ] **Step 2: Run RED and push test-only commit**

Focused command: `npx vitest run worker/test/translation-context-language.test.ts worker/test/translation-router.test.ts src/features/translation/translationSettingsApi.test.ts`.

- [ ] **Step 3: Update context DTOs/repository SQL**

Every glossary SELECT includes `target_language`; every target context query adds `AND target_language = ?`. Project-wide 200-entry cap remains project-wide.

- [ ] **Step 4: Update glossary HTTP compatibility**

Rules:
- omitted target = `vi`;
- invalid target -> `400 TARGET_LANGUAGE_UNSUPPORTED`;
- target-aware conflict response carries canonical context for the same requested target;
- style PATCH remains project-global.

- [ ] **Step 5: Update old backend call sites**

Every existing Vietnamese call becomes explicit `getContext(projectId, userId, 'vi')`; do not leave ambiguous overloads.

- [ ] **Step 6: Verify and commit GREEN**

Run: `npm run verify`.

Commit: `feat: scope translation context by target language`.

Verify exact-head CI FULL GREEN.

---

### Task 5: Owner-scoped Language and Translation Variant HTTP API

**Files:**
- Create: `worker/src/routes/languages.ts`
- Create: `worker/src/routes/translation-variants.ts`
- Create: `worker/test/language-routes.test.ts`
- Create: `worker/test/translation-variant-routes.test.ts`
- Create: `worker/src/workflows/LanguageTranslationWorkflow.ts`
- Create: `worker/src/workflows/languageTranslationPipeline.ts`
- Modify: `worker/src/app.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/index.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**

Routes:

```text
GET   /api/projects/:id/languages
PATCH /api/projects/:id/languages
GET   /api/projects/:id/translations/:language
PATCH /api/projects/:id/translations/:language/:segmentId
POST  /api/projects/:id/translations/:language/:segmentId/retranslate
POST  /api/projects/:id/translations/:language/process
```

Workflow params:

```ts
export type LanguageTranslationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  targetLanguage: TargetLanguage;
  requestId?: string;
};
```

- [ ] **Step 1: Write RED route tests**

Lock:
- owner-only 404 semantics;
- language config GET/PATCH and stale canonical 409;
- invalid/duplicate/empty target set rejected before DB mutation;
- translation list combines canonical source identity/timing with target variant;
- JA PATCH cannot mutate VI row;
- stale variant edit returns `409 TRANSLATION_VARIANT_CONFLICT` plus canonical variant;
- single retranslate uses canonical source and requested target;
- process route applies translate rate limit after authorization/validation and creates target Workflow params.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run worker/test/language-routes.test.ts worker/test/translation-variant-routes.test.ts`.

- [ ] **Step 3: Implement route validation/error mapping**

Use `isTargetLanguage`. Preserve error codes exactly:

```text
TARGET_LANGUAGE_UNSUPPORTED
PROJECT_LANGUAGES_CONFLICT
TRANSLATION_VARIANT_NOT_FOUND
TRANSLATION_VARIANT_CONFLICT
```

- [ ] **Step 4: Add Workflow binding**

`wrangler.jsonc`:

```json
{
  "binding": "LANGUAGE_TRANSLATION_WORKFLOW",
  "name": "dubflow-language-translation",
  "class_name": "LanguageTranslationWorkflow"
}
```

Add matching `Env` binding and export the Workflow class from `worker/src/index.ts`.

- [ ] **Step 5: Mount routes without reordering Phase 3C safety middleware**

Mount under `/api/projects`; do not move request telemetry, auth, or existing route ordering unnecessarily.

- [ ] **Step 6: Verify and commit GREEN**

Run:

```bash
npx vitest run worker/test/language-routes.test.ts worker/test/translation-variant-routes.test.ts
npm run verify
npx wrangler deploy --dry-run
```

Commit: `feat: add multi-language translation routes`.

Verify exact-head CI FULL GREEN.

---

### Task 6: Target Translation Workflow, Context Snapshot, and Accounting

**Files:**
- Complete: `worker/src/workflows/languageTranslationPipeline.ts`
- Complete: `worker/src/workflows/LanguageTranslationWorkflow.ts`
- Create: `worker/test/language-translation-workflow.test.ts`
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/test/dubbing-workflow-context.test.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`

**Interfaces:**

```ts
runLanguageTranslationPipeline(
  params: LanguageTranslationWorkflowParams,
  deps: LanguageTranslationPipelineDeps,
  step: WorkflowStepLike,
): Promise<{ status: 'needs_review'; targetLanguage: TargetLanguage; segmentCount: number }>;
```

- [ ] **Step 1: Write RED workflow tests**

Use at least 26 canonical segments to force two batches. Assert:
- `getContext(project,user,'ja')` called exactly once;
- same context object/revision passed to both batches;
- router receives target `'ja'` for both batches;
- translation operation keys include `translation:ja:batch-0` / `translation:ja:batch-25`;
- source Unicode character units use `Array.from(source).length`, including astral characters;
- all persisted rows have target JA and exact context revision;
- one target failure sets JA language status failed but does not mutate VI/KO;
- retry relies on usage operation idempotency and persisted rows instead of creating a second completed event for the same operation.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run worker/test/language-translation-workflow.test.ts`.

- [ ] **Step 3: Implement target pipeline**

Algorithm:

```ts
const context = await deps.translationContext.getContext(projectId, userId, targetLanguage);
for (const batch of batches(canonicalSegments, 25)) {
  const items = batch.map(({ id, sourceText }) => ({ id, text: sourceText }));
  const routed = await deps.translationRouter.translate(undefined, items, sourceLanguage, targetLanguage, context);
  // validate exact IDs/provider label, then record usage and persist target rows
}
```

The implementation code replacing the comment must:
1. compute source Unicode units;
2. record `started` with language-scoped operation key;
3. call the router through provider telemetry;
4. reject compare mode and any missing/duplicate/foreign IDs;
5. record `completed` only after a structurally valid provider result;
6. persist every target row with the exact context revision.

- [ ] **Step 4: Preserve the existing full dubbing path as Vietnamese compatibility**

The existing Dubbing Workflow still performs ASR then translates VI for the current V1 flow. Replace direct legacy-only persistence with the variant repository or an explicit compatibility adapter so both `segment_translations('vi')` and old segment columns stay aligned.

- [ ] **Step 5: Preserve Phase 3C telemetry and speaker stitching tests**

Do not alter ASR accounting, overlap stitching, speaker reconciliation, telemetry redaction, or provider-call wrapping.

- [ ] **Step 6: Verify and commit GREEN**

Run: `npm run verify`.

Commit: `feat: translate projects by target language`.

Verify exact-head CI FULL GREEN.

---

### Task 7: Per-language Export Persistence, Routes, and Batch Launch

**Files:**
- Modify: `worker/src/routes/export.ts`
- Create: `worker/test/multilanguage-export-route.test.ts`
- Modify: `worker/test/export-media-route.test.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/db/project-exports.ts`

**Interfaces:**

```text
POST /api/projects/:id/exports/:language
GET  /api/projects/:id/exports/:language
GET  /api/projects/:id/exports/:language/media
POST /api/projects/:id/exports/batch
```

Single start body:

```ts
{ output: 'dubbed' | 'subtitles' }
```

Batch body:

```ts
{ targetLanguages: TargetLanguage[]; output: 'dubbed' | 'subtitles' }
```

- [ ] **Step 1: Write RED route tests**

Assert:
- requested language must be enabled;
- translation variants must be complete/non-empty;
- dubbed output checks voice target capability before Workflow creation;
- subtitles output does not require voice credentials/capability;
- unknown voice language capability -> `VOICE_LANGUAGE_UNQUALIFIED`;
- explicit unsupported -> `VOICE_LANGUAGE_UNSUPPORTED`;
- batch creates one durable export row/workflow per requested target under one `batchId`;
- one Workflow-start failure is recorded for that language while other targets still launch;
- legacy `POST /:id/export` is exactly VI + dubbed;
- legacy `GET /:id/export/media` streams latest completed VI dubbed export.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run worker/test/multilanguage-export-route.test.ts worker/test/export-media-route.test.ts`.

- [ ] **Step 3: Extend `ExportWorkflow` params**

```ts
export type ExportWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  exportId: string;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  requestId?: string;
};
```

- [ ] **Step 4: Implement per-language routes and batch fan-out**

Keep Phase 3C export rate limit after project/target/output validation and before expensive Workflow creation. Batch returns per-language launch state and `batchId`; do not roll back successful launches when one target fails.

- [ ] **Step 5: Keep download telemetry/range behavior**

Owner downloads continue to emit `export_download`; target/output may be added only as additive non-sensitive fields accepted by current telemetry types.

- [ ] **Step 6: Verify and commit GREEN**

Run: `npm run verify`.

Commit: `feat: add per-language export routes`.

Verify exact-head CI FULL GREEN.

---

### Task 8: Language-aware TTS, Subtitle Output, Render, and Partial Retry

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Create: `worker/src/services/subtitles/srt.ts`
- Create: `worker/test/subtitle-export.test.ts`
- Create: `worker/test/multilanguage-export-workflow.test.ts`
- Modify: existing media/export workflow tests in `worker/test/`
- Modify: `tests/render-export-duration.test.mjs` only if its source guard expects the old render signature.

**Interfaces:**

```ts
renderExport(
  projectId: string,
  sourceObjectKey: string,
  clips: ExportClip[],
  options: { targetLanguage: TargetLanguage; exportId: string },
): Promise<{ exportObjectKey: string }>;
```

- [ ] **Step 1: Write RED subtitle/export workflow tests**

Assert:
- target translation text, not legacy VI text, feeds TTS;
- TTS `language` equals requested target;
- voice artifact key is `projects/{project}/voices/{lang}/{segment}/{version}.mp3`;
- TTS operation key contains target language;
- render operation key contains target language;
- final key is under `projects/{project}/exports/{lang}/{exportId}.mp4`;
- completed target TTS artifact is reused without new completed usage;
- subtitle output produces deterministic SRT and records no TTS/render usage;
- failed JA export does not invalidate completed VI/KO exports;
- successful retry only regenerates invalid/missing JA artifacts.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run worker/test/subtitle-export.test.ts worker/test/multilanguage-export-workflow.test.ts`.

- [ ] **Step 3: Implement deterministic SRT serialization**

```ts
export function serializeSrt(rows: { index: number; startMs: number; endMs: number; text: string }[]): string {
  return rows.map((row) => [
    String(row.index),
    `${formatSrtTime(row.startMs)} --> ${formatSrtTime(row.endMs)}`,
    row.text,
    '',
  ].join('\n')).join('\n');
}
```

`formatSrtTime` must clamp/reject invalid negative/non-finite inputs in tests and emit `HH:MM:SS,mmm`. Preserve translation text content and normalize line endings only.

- [ ] **Step 4: Parameterize export pipeline**

For `output === 'subtitles'`: serialize target translations, write immutable SRT key `projects/{project}/subtitles/{lang}/{exportId}.srt`, complete export row, skip voice/render usage.

For `output === 'dubbed'`: validate voice capability already admitted by route, reuse/generate target TTS, render language-scoped MP4, complete export row, and mirror `projects.export_object_key` only when target is `vi`.

- [ ] **Step 5: Update container render request/key validation**

No rendered output may return the old language-less project export prefix for new Phase 4C calls. Validate `projects/{project}/exports/{lang}/{exportId}.mp4` before publishing.

- [ ] **Step 6: Verify and commit GREEN**

Run:

```bash
npm run verify
npx wrangler deploy --dry-run
```

Commit: `feat: render language-specific exports`.

Verify exact-head CI FULL GREEN.

---

### Task 9: Frontend Language/Export API Clients

**Files:**
- Create: `src/features/translation/languageVariantsApi.ts`
- Create: `src/features/translation/languageVariantsApi.test.ts`
- Create: `src/features/export/batchExportApi.ts`
- Create: `src/features/export/batchExportApi.test.ts`
- Modify: `src/features/translation/translationSettingsApi.ts`
- Modify: `src/features/translation/translationSettingsApi.test.ts`

**Interfaces:**

```ts
export type TargetLanguage = 'vi' | 'en' | 'zh' | 'ja' | 'ko';
export type ExportOutput = 'dubbed' | 'subtitles';

getProjectLanguages(projectId): Promise<ProjectLanguageConfigDto>
patchProjectLanguages(projectId, targetLanguages, expectedLanguagesRevision): Promise<ProjectLanguageConfigDto>
getTranslationVariants(projectId, targetLanguage): Promise<TranslationVariantDto[]>
patchTranslationVariant(projectId, targetLanguage, segmentId, expectedVersion, translatedText): Promise<TranslationVariantDto>
processTargetLanguage(projectId, targetLanguage): Promise<JobLaunchDto>
startLanguageExport(projectId, targetLanguage, output): Promise<ExportLaunchDto>
startBatchExport(projectId, targetLanguages, output): Promise<BatchExportLaunchDto>
```

- [ ] **Step 1: Write RED API tests using mocked `fetch`**

Assert exact URL encoding, JSON bodies, omitted fields, and typed handling for:
- `PROJECT_LANGUAGES_CONFLICT` with canonical config;
- `TRANSLATION_VARIANT_CONFLICT` with canonical variant;
- partial batch launch responses;
- glossary target language request/response.

- [ ] **Step 2: Run RED and push test-only commit**

Run: `npx vitest run src/features/translation/languageVariantsApi.test.ts src/features/export/batchExportApi.test.ts src/features/translation/translationSettingsApi.test.ts`.

- [ ] **Step 3: Implement API clients with current `apiFetch` patterns**

Do not introduce a second HTTP client. Preserve existing error parsing behavior and expose conflict subclasses/data only where the UI needs canonical replacement.

- [ ] **Step 4: Verify and commit GREEN**

Run: `npm run verify`.

Commit: `feat: add multi-language studio APIs`.

Verify exact-head CI FULL GREEN.

---

### Task 10: Studio Target-language, Glossary, Transcript, and Batch Export UI

**Files:**
- Create: `src/features/translation/TargetLanguagesPanel.tsx`
- Create: `src/features/translation/TargetLanguagesPanel.test.tsx`
- Create: `src/features/export/BatchExportPanel.tsx`
- Create: `src/features/export/BatchExportPanel.test.tsx`
- Create: `src/features/export/batch-export.css`
- Modify: `src/features/translation/TranslationSettingsPanel.tsx`
- Modify: `src/features/translation/TranslationSettingsPanel.test.tsx`
- Modify: `src/features/translation/translation-settings.css`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/StudioShellTranslationSettings.test.tsx`

**Interfaces:**

```ts
const LANGUAGE_LABELS = {
  vi: 'Tiếng Việt',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
} as const;
```

- [ ] **Step 1: Identify the exact transcript editor imports used by the current `StudioShell` before writing tests**

Run: `grep -n "transcript\|ScriptInspector\|translated" src/app/StudioShell.tsx`.

Add only those concrete imported transcript files to this task's mutation set; do not refactor unrelated editor state.

- [ ] **Step 2: Write RED presentational/state tests**

Using the repo's current `renderToStaticMarkup`/Vitest style, assert:
- cloud project shows Target Languages control; demo project remains unchanged;
- current language selector has Source + enabled targets;
- switching target changes translated field binding but not source/timing/speaker identity;
- language status chips show pending/translating/needs review/ready/exporting/completed/failed truthfully;
- glossary form includes target selector and shows only target entries;
- stale language config conflict replaces UI state with canonical server config and does not retry automatically;
- stale translation conflict replaces only current language variant;
- batch export panel exposes `Export current language` and `Batch export selected languages`;
- partial batch keeps successful rows and a retry action only for failed target;
- dubbed export disabled with explicit reason when voice capability is unsupported/unknown; subtitles remain available.

- [ ] **Step 3: Run RED and push test-only commit**

Run:

```bash
npx vitest run src/features/translation/TargetLanguagesPanel.test.tsx src/features/export/BatchExportPanel.test.tsx src/app/StudioShell.test.tsx src/features/translation/TranslationSettingsPanel.test.tsx
```

- [ ] **Step 4: Implement target-language state in `StudioShell`**

Keep one `currentTargetLanguage` state scoped to cloud project. Source segment/timeline selection remains shared. Fetch target variants on language change and map them by canonical segment ID; never clone timeline/source rows.

- [ ] **Step 5: Implement target-aware glossary UI**

Changing glossary target filters/creates entries for that target. Style preset remains project-global. No automatic retranslate after glossary/style save.

- [ ] **Step 6: Implement batch export UI**

Render one row per selected target and preserve partial result state. Do not display a global success badge unless every requested target succeeds.

- [ ] **Step 7: Keep editor mutation safety**

Existing autosave/conflict/mutation-lock semantics remain. Target translation save uses target variant `version`; source edits still use canonical segment `version`.

- [ ] **Step 8: Verify and commit GREEN**

Run:

```bash
npm run verify
npx wrangler deploy --dry-run
```

Commit: `feat: add multi-language studio controls`.

Verify exact-head CI FULL GREEN and reference screenshot artifact gates.

---

### Task 11: Phase 4C Acceptance, Documentation, Reconciliation, PR, and Merge

**Files:**
- Create: `tests/phase4c-multilanguage-export-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`
- Modify: spec/plan migration filename only if live `main` has claimed `0009` before merge.

**Interfaces:**
- Produces source/CI qualification evidence only; production remains unqualified.

- [ ] **Step 1: Write RED source acceptance guard**

Assert source-level invariants:

```js
assert.match(migration, /CREATE TABLE segment_translations/);
assert.match(migration, /target_language/);
assert.match(router, /TargetLanguage/);
assert.match(languagePipeline, /targetLanguage/);
assert.match(exportPipeline, /voices\/\$\{.*targetLanguage/);
assert.match(exportRoute, /VOICE_LANGUAGE_UNQUALIFIED/);
assert.match(studio, /TargetLanguagesPanel/);
assert.match(studio, /BatchExportPanel/);
```

Also assert:
- Vietnamese legacy route markers remain;
- Phase 3C rate-limit/telemetry wrappers still exist around expensive routes/provider calls;
- Phase 4A translation context and speaker stitching acceptance files remain wired;
- Phase 4B voice-clone acceptance remains wired;
- no production deployment status claim.

- [ ] **Step 2: Wire acceptance into `verify:deploy-config` and verify intended RED**

Add `tests/phase4c-multilanguage-export-acceptance.test.mjs` to the existing Node test command in `package.json`.

Run: `node --test tests/phase4c-multilanguage-export-acceptance.test.mjs`.

If all source already satisfies it, make the RED phase about missing deployment-status qualification wording; do not weaken a correct test to manufacture failure.

- [ ] **Step 3: Update deployment status**

Document:
- Phase 4C source/CI qualification;
- supported targets;
- compatibility bridge;
- production runtime still UNQUALIFIED/manual-only;
- provider/model/voice/media real-fixture qualification still required before production claims.

- [ ] **Step 4: Run complete fresh verification**

Run:

```bash
npm run verify
npx wrangler deploy --dry-run
```

Then require GitHub exact-head CI to pass:
- all Node source guards;
- all Vitest tests;
- TypeScript/Vite build;
- Wrangler dry-run;
- CJK screenshot font gate;
- reference screenshot capture;
- artifact upload.

- [ ] **Step 5: Self-review the full feature diff**

Check:
- no target-to-target translation path;
- no source/timing/speaker duplication;
- no accidental voice-clone enrollment changes;
- no duplicate migration number;
- no placeholder files/refs;
- no removed Phase 3C/4A/4B acceptance wiring;
- no provider fallback when active context or target capability is unsupported;
- no usage operation key collision across languages.

- [ ] **Step 6: Reconcile with live `main` before PR**

Re-fetch live `main` and branch. If `main` advanced:
- compare changed paths;
- merge/reconcile non-force;
- renumber `0009_multilanguage_variants.sql` only if another migration now owns `0009`;
- rerun exact-head full CI on the reconciled feature head.

- [ ] **Step 7: Open PR and require PR-triggered exact-head GREEN**

PR title: `feat: add batch multi-language translation and export`

PR body must list supported targets, compatibility bridge, usage semantics, voice fail-closed behavior, exact feature head, push CI run, and runtime-unqualified boundary.

- [ ] **Step 8: Final expected-head merge gate**

Immediately before merge:
- re-fetch live `main`;
- re-fetch PR head/mergeability;
- verify PR-triggered CI full success on exact head;
- merge using `expected_head_sha` / non-force merge semantics.

- [ ] **Step 9: Verify post-merge `main` CI**

Require a new push CI run whose `head_sha` is the actual merge commit and whose full job concludes `success` before calling Phase 4C complete.

Do not deploy production.
