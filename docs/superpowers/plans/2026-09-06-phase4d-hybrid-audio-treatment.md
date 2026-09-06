# Phase 4D Hybrid Audio Treatment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three backward-compatible dubbed-audio treatments: existing dubbed-only output, deterministic source-audio ducking, and fail-closed provider-backed separated-background rendering.

**Architecture:** Keep the single canonical export pipeline. Extend the existing `RenderExportOptions` seam, persist source generation and export audio mode in D1, reuse provider stems through one owner-scoped `project_audio_stems` repository, and keep the production separation adapter unavailable until a provider-specific qualification lane exists. FFmpeg remains the only final renderer.

**Tech Stack:** TypeScript 5.8, Hono, Cloudflare Workers/Workflows/D1/R2, React 19, Vitest, Node test runner, FFmpeg container, Wrangler dry-run.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4d-hybrid-audio-treatment-design.md`

## Global Constraints

- Canonical type is `DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background'`.
- Omitted `audioMode` resolves to `dubbed_only`.
- `duck_original` is deterministic preservation/ducking, never AI separation.
- Duck gain is exactly `-18 dB`; attack lead `80 ms`; release tail `120 ms`.
- `separated_background` never silently downgrades.
- True separation requires `configured=true`, `qualification='qualified'`, `backgroundStem=true`, and a non-empty provider identity.
- Canonical table is `project_audio_stems`.
- Canonical stem prefix is `projects/{projectId}/stems/{sourceGeneration}/{provider}/`.
- First source assignment keeps generation `1`; same-key completion is idempotent; a different durable source increments generation exactly once.
- One completed current-generation background stem is reusable across `vi/en/zh/ja/ko`.
- Failed stem rows must not permanently block retry.
- GitHub Actions is CI-only; Cloudflare Workers Builds is the only production deployment lane.
- Do not manually deploy production in this plan.

---

### Task 1: Forward migration, source generation, and export audio mode

**Files:**
- Create: `migrations/0011_phase4d_audio_separation.sql`
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/src/db/project-exports.ts`
- Modify: `worker/test/project-repository.test.ts`
- Modify: `worker/test/project-exports.test.ts`
- Create: `tests/phase4d-audio-separation-migration.test.mjs`

**Interfaces:**
- Produces `Project.sourceGeneration: number`.
- Produces `ProjectExport.audioMode: DubbedAudioMode`.
- Produces schema `project_audio_stems` for Task 2.

- [ ] **Step 1: Write RED repository/migration tests.** Lock these exact semantics:

```ts
expect(project.sourceGeneration).toBe(1);
await projects.setSourceObject('p1', 'u1', 'projects/p1/source/a.mp4', 10);
expect((await projects.getByIdForUser('p1', 'u1'))?.sourceGeneration).toBe(1);
await projects.setSourceObject('p1', 'u1', 'projects/p1/source/a.mp4', 10);
expect((await projects.getByIdForUser('p1', 'u1'))?.sourceGeneration).toBe(1);
await projects.setSourceObject('p1', 'u1', 'projects/p1/source/b.mp4', 11);
expect((await projects.getByIdForUser('p1', 'u1'))?.sourceGeneration).toBe(2);

const attempt = await exports.create('p1', 'u1', 'ja', 'dubbed', null, 'duck_original');
expect(attempt.audioMode).toBe('duck_original');
```

Migration test applies existing migrations through `0010`, seeds project/export/share rows, executes `0011`, runs `PRAGMA foreign_key_check`, and verifies existing export/share data survives.

- [ ] **Step 2: Run RED.**

```bash
npx vitest run worker/test/project-repository.test.ts worker/test/project-exports.test.ts
node --test tests/phase4d-audio-separation-migration.test.mjs
```

Expected: FAIL because `source_generation`, `audio_mode`, and `0011` do not exist.

- [ ] **Step 3: Create forward migration.** Use this active-row uniqueness contract:

```sql
PRAGMA defer_foreign_keys = ON;

ALTER TABLE projects ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 1
  CHECK (source_generation >= 1);

ALTER TABLE project_exports ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'dubbed_only'
  CHECK (audio_mode IN ('dubbed_only','duck_original','separated_background'));

CREATE TABLE project_audio_stems (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('background','dialogue')),
  provider TEXT NOT NULL,
  provider_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','invalidated')),
  object_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_project_audio_stems_active
  ON project_audio_stems(project_id, source_generation, kind, provider)
  WHERE status IN ('pending','completed');

CREATE INDEX idx_project_audio_stems_lookup
  ON project_audio_stems(project_id, source_generation, kind, provider, status, created_at DESC);

CREATE TRIGGER trg_projects_invalidate_audio_stems
AFTER UPDATE OF source_generation ON projects
WHEN NEW.source_generation != OLD.source_generation
BEGIN
  UPDATE project_audio_stems
  SET status = 'invalidated', updated_at = datetime('now')
  WHERE project_id = NEW.id
    AND source_generation != NEW.source_generation
    AND status != 'invalidated';
END;

PRAGMA defer_foreign_keys = OFF;
```

- [ ] **Step 4: Extend project repository.** Add `sourceGeneration/source_generation` to DTO/row/select columns. Implement idempotent generation advance:

```ts
await this.db.prepare(
  `UPDATE projects
   SET source_generation = CASE
         WHEN source_object_key IS NULL OR source_object_key = ? THEN source_generation
         ELSE source_generation + 1
       END,
       source_object_key = ?, size_bytes = ?, status = 'ready', updated_at = datetime('now')
   WHERE id = ? AND user_id = ?`,
).bind(objectKey, objectKey, sizeBytes, id, userId).run();
```

- [ ] **Step 5: Extend export repository.** Add `audioMode/audio_mode` to DTO/row/selects. Extend create signature with optional `audioMode: DubbedAudioMode = 'dubbed_only'`. Subtitle callers persist `dubbed_only`.

- [ ] **Step 6: Run GREEN and commit.**

```bash
npx vitest run worker/test/project-repository.test.ts worker/test/project-exports.test.ts
node --test tests/phase4d-audio-separation-migration.test.mjs
git commit -am "feat(phase4d): persist source generation and audio mode"
```

---

### Task 2: Audio-mode domain, stem repository, and unavailable provider

**Files:**
- Create: `worker/src/domain/audio-mode.ts`
- Create: `worker/src/db/audio-stems.ts`
- Create: `worker/src/services/separation/types.ts`
- Create: `worker/src/services/separation/unavailable.ts`
- Create: `worker/test/audio-stems.test.ts`
- Create: `worker/test/dialogue-separation-provider.test.ts`

**Interfaces:**
- Produces `DubbedAudioMode` and `parseDubbedAudioMode(value)`.
- Produces `DialogueSeparationProvider` and `DialogueSeparationError`.
- Produces `AudioStemRepository.latestCompleted`, `begin`, `complete`, `fail`.

- [ ] **Step 1: Write RED tests.**

```ts
expect(parseDubbedAudioMode(undefined)).toBe('dubbed_only');
expect(parseDubbedAudioMode('duck_original')).toBe('duck_original');
expect(parseDubbedAudioMode('separated_background')).toBe('separated_background');
expect(parseDubbedAudioMode('bad')).toBeNull();

await expect(new UnavailableDialogueSeparationProvider().capabilities()).resolves.toEqual({
  configured: false,
  provider: null,
  backgroundStem: false,
  dialogueStem: false,
  qualification: 'unavailable',
});
```

Stem tests cover owner scoping, exact generation/provider selection, cross-project key rejection, failed-row retry, and invalidated-row exclusion.

- [ ] **Step 2: Run RED.**

```bash
npx vitest run worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
```

- [ ] **Step 3: Implement domain parser.**

```ts
export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';
export function parseDubbedAudioMode(value: unknown): DubbedAudioMode | null {
  if (value === undefined) return 'dubbed_only';
  return value === 'dubbed_only' || value === 'duck_original' || value === 'separated_background' ? value : null;
}
```

- [ ] **Step 4: Implement provider contracts exactly from spec.** `UnavailableDialogueSeparationProvider.separate()` throws `DIALOGUE_SEPARATION_UNAVAILABLE`; it never returns fake stems.

- [ ] **Step 5: Implement owner-scoped stem repository.** `complete(...)` requires key prefix:

```ts
const prefix = `projects/${projectId}/stems/${sourceGeneration}/${provider}/`;
if (!objectKey.startsWith(prefix)) throw new Error('Audio stem object key is outside the canonical project/source/provider prefix.');
```

`begin(...)` returns an existing active row if one already exists; a failed row permits a new pending retry.

- [ ] **Step 6: Run GREEN and commit.**

```bash
npx vitest run worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
git add worker/src/domain/audio-mode.ts worker/src/db/audio-stems.ts worker/src/services/separation worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
git commit -m "feat(phase4d): add audio stem and provider contracts"
```

---

### Task 3: Media processor and container request validation

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `worker/test/media-container.test.ts`
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`
- Modify: `containers/ffmpeg/server.mjs`

**Interfaces:**
- Produces `RenderExportOptions { targetLanguage, exportId, audioMode?, backgroundObjectKey? }`.

- [ ] **Step 1: Write RED tests.** Container rejects invalid mode, missing separated background key, non-separated background key, and cross-project stem. Media adapter forwards exact fields.

- [ ] **Step 2: Run RED.**

```bash
node --test containers/ffmpeg/render-export.test.mjs
npx vitest run worker/test/media-container.test.ts
```

- [ ] **Step 3: Extend TypeScript media contract.**

```ts
export type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  audioMode?: DubbedAudioMode;
  backgroundObjectKey?: string;
};
```

- [ ] **Step 4: Extend request validation.** Resolve omitted mode to `dubbed_only`; separated mode requires `projects/${projectId}/stems/`; other modes reject a background key.

- [ ] **Step 5: Stage separated background in `server.mjs`.** Only separated mode performs R2 fetch to a temp stem path; other modes do not fetch any stem.

- [ ] **Step 6: Run GREEN and commit.**

```bash
node --test containers/ffmpeg/render-export.test.mjs
npx vitest run worker/test/media-container.test.ts
git add worker/src/services/media containers/ffmpeg worker/test/media-container.test.ts
git commit -m "feat(phase4d): extend media render audio contract"
```

---

### Task 4: Deterministic FFmpeg ducking and separated-background graphs

**Files:**
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`
- Modify: `tests/render-export-duration.test.mjs`

**Interfaces:**
- Produces `mergeDialogueWindows(clips, attackMs, releaseMs)`.
- Produces exact three-mode render graphs.

- [ ] **Step 1: Write RED graph tests.** `dubbed_only` retains silent base; `duck_original` uses source audio; `separated_background` uses background stem and excludes source audio from final mix.

- [ ] **Step 2: Add RED window-merging test.** Target implementation:

```js
export function mergeDialogueWindows(clips, attackMs = 80, releaseMs = 120) {
  const ranges = clips.map((clip) => ({
    startMs: Math.max(0, clip.startMs - attackMs),
    endMs: clip.endMs + releaseMs,
  })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.startMs > last.endMs) merged.push({ ...range });
    else last.endMs = Math.max(last.endMs, range.endMs);
  }
  return merged;
}
```

For `[1000,2000]` plus `[1950,2500]`, expect `{ startMs: 920, endMs: 2620 }`.

- [ ] **Step 3: Run RED.**

```bash
node --test containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
```

- [ ] **Step 4: Add exact constants.**

```js
export const DUCK_GAIN_DB = -18;
export const DUCK_ATTACK_MS = 80;
export const DUCK_RELEASE_MS = 120;
export const DUCK_GAIN_LINEAR = 10 ** (DUCK_GAIN_DB / 20);
```

Build FFmpeg gain expressions only from validated numeric windows.

- [ ] **Step 5: Implement graphs.** `dubbed_only` preserves current behavior. `duck_original` normalizes `[0:a]`, applies gain automation, then mixes dubbed clips. `separated_background` normalizes staged background and mixes dubbed clips without original source audio. Preserve existing video mapping, AAC 48 kHz stereo, and canonical duration bound.

- [ ] **Step 6: Run GREEN and commit.**

```bash
node --test containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
git add containers/ffmpeg/render-export.mjs containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
git commit -m "feat(phase4d): add source ducking and stem mix graphs"
```

---

### Task 5: Export API, capability endpoint, and persistence

**Files:**
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/test/multilanguage-export-route.test.ts`
- Modify: `worker/src/db/project-exports.ts`

**Interfaces:**
- Produces `GET /api/projects/:id/export-capabilities`.
- Produces workflow params containing `audioMode`.

- [ ] **Step 1: Write RED route tests.** Cover omitted/default mode, invalid mode, subtitle+non-default rejection, batch propagation, and separated unavailable/unqualified failures before export/job/workflow side effects.

- [ ] **Step 2: Write RED capability endpoint tests.** Owner-only response shape:

```ts
{
  duckOriginal: true,
  separation: {
    configured: false,
    provider: null,
    backgroundStem: false,
    dialogueStem: false,
    qualification: 'unavailable'
  }
}
```

- [ ] **Step 3: Run RED.**

```bash
npx vitest run worker/test/multilanguage-export-route.test.ts
```

- [ ] **Step 4: Add `makeSeparation` route dependency.** Default to `UnavailableDialogueSeparationProvider`.

- [ ] **Step 5: Add audio-mode validation.** For `separated_background`, require qualified capability after owner/target validation but before rate-limit consumption and any export/job/workflow side effect.

- [ ] **Step 6: Persist and forward mode.** `launchValidated(..., audioMode)` stores it and sends it in Workflow params. Legacy export always uses `dubbed_only`.

- [ ] **Step 7: Implement capability endpoint.** It authorizes the project before revealing provider capability.

- [ ] **Step 8: Run GREEN and commit.**

```bash
npx vitest run worker/test/multilanguage-export-route.test.ts
git add worker/src/routes/export.ts worker/src/db/project-exports.ts worker/test/multilanguage-export-route.test.ts
git commit -m "feat(phase4d): admit and expose audio treatment capability"
```

---

### Task 6: Export workflow stem reuse, usage idempotency, cancellation

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/exportWorkflow.ts`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/test/exportPipeline.test.ts`
- Modify: `worker/test/usage-repository.test.ts`

**Interfaces:**
- Consumes `AudioStemRepository` and `DialogueSeparationProvider`.
- Produces usage kind `dialogue_separation_second` only when provider work runs.

- [ ] **Step 1: Write RED workflow tests.** Cover duck mode never calling provider; separated reuse; first provider call; cross-language reuse; durable-stem accounting recovery; provider failure; invalid key; completed accounting without durable stem fail-closed; cancellation before provider/render/publish.

- [ ] **Step 2: Run RED.**

```bash
npx vitest run worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
```

- [ ] **Step 3: Extend usage totals/kind.** Add `dialogue_separation_second` and `dialogueSeparationSeconds`; no event for ducking or unavailable provider.

- [ ] **Step 4: Normalize workflow audio mode.** Legacy becomes `dubbed_only`; modern validates exact enum.

- [ ] **Step 5: Implement separated background resolution.** Exact operation key:

```ts
const operationKey = `project:${projectId}:source:${sourceGeneration}:dialogue-separation:${provider}`;
```

Resolution order is capability -> reusable durable stem -> accounting recovery -> cancellation -> pending stem -> started usage -> provider -> key validation -> stem completion -> completed usage -> render key.

- [ ] **Step 6: Wire production default.** `exportWorkflow.ts` creates `AudioStemRepository(env.DB)` and `UnavailableDialogueSeparationProvider`. Tests inject qualified mocks; production does not claim a provider.

- [ ] **Step 7: Pass render options.** Include `audioMode`; include `backgroundObjectKey` only for separated mode.

- [ ] **Step 8: Run GREEN and commit.**

```bash
npx vitest run worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
git add worker/src/workflows worker/src/db/usage.ts worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
git commit -m "feat(phase4d): reuse separation stems in export workflow"
```

---

### Task 7: Cloud Studio client and honest audio-treatment controls

**Files:**
- Modify: `src/features/export/batchExportApi.ts`
- Modify: `src/features/export/batchExportApi.test.ts`
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batch-export.css`
- Modify: `src/app/phase4cStudioContext.tsx`

**Interfaces:**
- Produces selected `audioMode` in dubbed single/batch requests.
- Consumes `/export-capabilities`.

- [ ] **Step 1: Write RED API tests.** Dubbed request includes mode; subtitle request omits it.

- [ ] **Step 2: Write RED UI tests.** Exact labels are `Dubbed voice only`, `Keep original ambience (duck dialogue)`, `Separated background stem`. Separated is disabled unless capability is qualified. Duck remains selectable. UI never calls ducking AI separation.

- [ ] **Step 3: Run RED.**

```bash
npx vitest run src/features/export/batchExportApi.test.ts src/features/export/BatchExportPanel.test.tsx
```

- [ ] **Step 4: Extend client helpers.** Add `DubbedAudioMode`; default `dubbed_only`; include mode only for dubbed output. Add `fetchExportCapabilities(projectId)`.

- [ ] **Step 5: Extend studio context.** Default selected mode `dubbed_only`; load capability owner-scoped; preserve selection across language switches; retry failed dubbed target with same mode; subtitles ignore mode.

- [ ] **Step 6: Add selector and capability copy.** Keep voice-provider gating separate from separation gating.

- [ ] **Step 7: Run GREEN and commit.**

```bash
npx vitest run src/features/export/batchExportApi.test.ts src/features/export/BatchExportPanel.test.tsx
git add src/features/export src/app/phase4cStudioContext.tsx
git commit -m "feat(phase4d): add audio treatment controls"
```

---

### Task 8: Cross-layer acceptance, docs, and full exact-head verification

**Files:**
- Create: `tests/phase4d-hybrid-audio-treatment-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/deployment-status.md`

- [ ] **Step 1: Write RED acceptance guard.** Assert migration `0011_phase4d_audio_separation.sql`, `project_audio_stems`, `source_generation`, `audio_mode`, exact duck constants, three mode tokens, stable separation errors, capability endpoint, honest UI labels, unavailable production adapter, and absence of GitHub production deploy workflow.

- [ ] **Step 2: Wire into `verify:deploy-config` and run RED.**

```bash
npm run verify:deploy-config
```

- [ ] **Step 3: Update docs.** Document all three modes, true separation as unavailable/unqualified until provider lane, source-generation reuse rules, no manual production deploy, and production runtime remaining UNQUALIFIED.

- [ ] **Step 4: Run full verification.**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: source guards, Vitest, TypeScript/Vite build, migration build helper, and Wrangler dry-run all PASS.

- [ ] **Step 5: Commit.**

```bash
git add tests/phase4d-hybrid-audio-treatment-acceptance.test.mjs package.json README.md docs/deployment-status.md
git commit -m "test(phase4d): qualify hybrid audio treatment source contract"
```

---

### Task 9: Latest-main reconciliation, review, PR, merge, post-merge CI

- [ ] **Step 1: Refetch live `main` immediately before final gate.** If main moved, compare drift and non-force merge latest main into this carrier; never force-update.

- [ ] **Step 2: Rerun exact-head full verification after any refresh.** Record the exact feature SHA and fresh CI run; older green runs do not qualify a new head.

- [ ] **Step 3: Review high-risk seams.** Confirm unique migration number, idempotent source generation, failed-stem retry, no provider use by ducking, fail-closed separated mode, cross-project key rejection, Phase4C concrete share behavior, dedicated batch limiter, and CI-only deploy policy.

- [ ] **Step 4: Open final PR** titled `feat: add Phase 4D hybrid audio treatment`. Body records exact head/run evidence and states `Production runtime remains UNQUALIFIED`.

- [ ] **Step 5: Require fresh PR CI and no unresolved review thread.** No bypass.

- [ ] **Step 6: Merge using `expected_head_sha=<exact tested head>`**, non-force.

- [ ] **Step 7: Fetch live `main` and require post-merge CI on the exact merge SHA to finish `completed/success`, including verify/build, Wrangler dry-run, CJK screenshot, and artifact upload.

- [ ] **Step 8: Do not manually deploy production.** Cloudflare Workers Builds remains the production lane; do not call provider/media runtime qualified without separate real-fixture qualification.
