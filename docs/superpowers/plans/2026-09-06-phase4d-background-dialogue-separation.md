# Phase 4D Background / Dialogue Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backward-compatible dubbed-audio modes with deterministic source-audio ducking plus a fail-closed, reusable dialogue-separation provider boundary for multi-language exports.

**Architecture:** Keep one canonical export pipeline and extend its existing `RenderExportOptions` seam. `duck_original` is an always-local FFmpeg preservation mode; `separated_background` resolves one project/source-generation background stem through a qualified provider boundary and reuses that stem across target languages. Persistence uses forward migration `0011_phase4d_audio_separation.sql`, with `projects.source_generation`, `project_audio_stems`, and `project_exports.audio_mode` as the durable source of truth.

**Tech Stack:** TypeScript 5.8, Hono, Cloudflare Workers/Workflows/D1/R2, React 19, Vitest, Node test runner, FFmpeg container, Wrangler dry-run.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4d-background-dialogue-separation-design.md`

## Global Constraints

- Dubbed audio modes are exactly `dubbed_only`, `duck_original`, and `separated_background`.
- Omitted `audioMode` resolves to `dubbed_only`; existing clients must keep existing output behavior.
- `duck_original` is source-audio preservation/ducking and must never be labeled AI separation.
- Ducking attenuation is exactly `-18 dB`, with attack `80 ms` and release `120 ms`.
- `separated_background` is fail-closed: no silent downgrade to `duck_original` or `dubbed_only`.
- True separation requires `configured=true`, `qualification='qualified'`, and `backgroundStem=true`.
- Canonical stem table is `project_audio_stems`.
- Canonical stem keys are `projects/{projectId}/stems/{sourceGeneration}/{provider}/background.wav` and optional `dialogue.wav`.
- One valid background stem is reusable across `vi`, `en`, `zh`, `ja`, and `ko` for the same project/source generation/provider.
- GitHub Actions remains CI-only; production deployment remains Cloudflare Workers Builds only.
- No manual production deployment in this plan.

---

## File Structure

### New files

- `migrations/0011_phase4d_audio_separation.sql` — forward schema for source generation, export audio mode, and stem metadata.
- `worker/src/domain/audio-mode.ts` — canonical mode type/parser and API validation helpers.
- `worker/src/services/separation/types.ts` — provider capability/input/result contracts.
- `worker/src/services/separation/unavailable.ts` — safe default provider that never claims qualification.
- `worker/src/db/audio-stems.ts` — owner-scoped canonical stem persistence and reuse selection.
- `worker/test/audio-stems.test.ts` — D1 repository contract tests.
- `worker/test/dialogue-separation-provider.test.ts` — capability/result validation tests.
- `tests/phase4d-audio-separation-acceptance.test.mjs` — source/config/docs acceptance guard.

### Existing files to modify

- `worker/src/db/projects.ts` — expose/increment `sourceGeneration` on successful source replacement.
- `worker/src/db/project-exports.ts` — persist/return `audioMode`.
- `worker/src/db/usage.ts` — add real provider separation metering kind.
- `worker/src/services/media/types.ts` — extend render contract with `audioMode` and optional background stem key.
- `worker/src/services/media/container.ts` — send the new render options to the FFmpeg container.
- `containers/ffmpeg/render-export.mjs` — validate audio mode/stem key and build three deterministic render graphs.
- `containers/ffmpeg/render-export.test.mjs` — container RED/GREEN contract tests.
- `containers/ffmpeg/server.mjs` — fetch validated background stem for separated mode before render.
- `worker/src/routes/export.ts` — parse/validate audio mode, persist it, capability-gate separated export, pass through Workflow params.
- `worker/src/workflows/exportPipeline.ts` — resolve/reuse/create stem, meter provider, pass background key into render.
- `worker/src/workflows/exportWorkflow.ts` — wire stem repository and default unavailable provider into pipeline deps.
- `worker/test/multilanguage-export-route.test.ts` — single/batch audio-mode route behavior.
- `worker/test/exportPipeline.test.ts` — local ducking/no-provider and separated provider workflow cases.
- `src/features/export/batchExportApi.ts` — send audio mode on dubbed exports.
- `src/features/export/batchExportApi.test.ts` — client request contract.
- `src/features/export/BatchExportPanel.tsx` — explicit audio treatment selector/capability state.
- `src/features/export/BatchExportPanel.test.tsx` — UI wording/disable rules.
- `src/features/export/batch-export.css` — layout for audio-mode controls.
- `src/app/phase4cStudioContext.tsx` — hold selected audio mode and separation capability for export actions.
- `package.json` — include Phase 4D acceptance guard in `verify:deploy-config`.
- `README.md` — document modes and qualification boundary.
- `docs/deployment-status.md` — Phase 4D source/CI qualification statement; production runtime remains unqualified.

---

### Task 1: Forward schema, source generation, and persisted export audio mode

**Files:**
- Create: `migrations/0011_phase4d_audio_separation.sql`
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/src/db/project-exports.ts`
- Test: `worker/test/project-repository.test.ts`
- Test: `worker/test/project-exports.test.ts`
- Test: `tests/phase4d-audio-separation-acceptance.test.mjs`

**Interfaces:**
- Produces: `Project.sourceGeneration: number`
- Produces: `ProjectExport.audioMode: DubbedAudioMode`
- Produces: `ProjectExportRepository.create(projectId, userId, targetLanguage, output, batchId, audioMode)`
- Produces schema: `project_audio_stems`, consumed by Task 2.

- [ ] **Step 1: Write failing schema and repository tests**

Add assertions that a project row exposes generation `1`, successful `setSourceObject(...)` increments it exactly once, and a new export row persists `audio_mode='duck_original'`.

```ts
expect(project.sourceGeneration).toBe(1);
await repo.setSourceObject('p1', 'u1', 'projects/p1/source/new.mp4', 42);
expect((await repo.getByIdForUser('p1', 'u1'))?.sourceGeneration).toBe(2);

const attempt = await exports.create('p1', 'u1', 'ja', 'dubbed', null, 'duck_original');
expect(attempt.audioMode).toBe('duck_original');
```

Add a Node acceptance assertion that migration `0011_phase4d_audio_separation.sql` contains `source_generation`, `project_audio_stems`, and `audio_mode` and that migration numbers remain unique.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run worker/test/project-repository.test.ts worker/test/project-exports.test.ts
node --test tests/phase4d-audio-separation-acceptance.test.mjs
```

Expected: FAIL because generation/audio mode/migration do not exist.

- [ ] **Step 3: Create migration `0011_phase4d_audio_separation.sql`**

Use this schema shape:

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

CREATE UNIQUE INDEX idx_project_audio_stems_canonical
  ON project_audio_stems(project_id, source_generation, kind, provider)
  WHERE status != 'invalidated';

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

- [ ] **Step 4: Extend project/export repositories minimally**

In `Project`, `ProjectRow`, and `PROJECT_COLUMNS`, add `sourceGeneration/source_generation`. Update `setSourceObject`:

```ts
SET source_object_key = ?, size_bytes = ?, status = 'ready',
    source_generation = source_generation + 1,
    updated_at = datetime('now')
```

In `ProjectExport`, row mapping, selects, and `create`, add `audioMode/audio_mode`; for subtitles pass/persist `dubbed_only`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same commands from Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0011_phase4d_audio_separation.sql worker/src/db/projects.ts worker/src/db/project-exports.ts worker/test/project-repository.test.ts worker/test/project-exports.test.ts tests/phase4d-audio-separation-acceptance.test.mjs
git commit -m "feat(phase4d): persist audio modes and source generations"
```

---

### Task 2: Canonical audio-mode domain and stem repository/provider contracts

**Files:**
- Create: `worker/src/domain/audio-mode.ts`
- Create: `worker/src/db/audio-stems.ts`
- Create: `worker/src/services/separation/types.ts`
- Create: `worker/src/services/separation/unavailable.ts`
- Create: `worker/test/audio-stems.test.ts`
- Create: `worker/test/dialogue-separation-provider.test.ts`

**Interfaces:**
- Produces: `DubbedAudioMode`
- Produces: `parseDubbedAudioMode(value): DubbedAudioMode | null`
- Produces: `DialogueSeparationCapabilities`, `SeparateDialogueInput`, `SeparationResult`, `DialogueSeparationProvider`
- Produces: `AudioStemRepository.latestCompleted(...)`, `begin(...)`, `complete(...)`, `fail(...)`.

- [ ] **Step 1: Write RED domain/provider/repository tests**

```ts
expect(parseDubbedAudioMode(undefined)).toBe('dubbed_only');
expect(parseDubbedAudioMode('duck_original')).toBe('duck_original');
expect(parseDubbedAudioMode('bogus')).toBeNull();

expect(new UnavailableDialogueSeparationProvider().capabilities()).resolves.toEqual({
  configured: false,
  provider: null,
  backgroundStem: false,
  dialogueStem: false,
  qualification: 'unavailable',
});
```

Repository test: create a completed background row for `(p1, generation=2, provider='mock-sep')`, verify owner-scoped lookup returns it and generation `3` does not.

- [ ] **Step 2: Run RED tests**

```bash
npx vitest run worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
```

Expected: FAIL with missing modules/types.

- [ ] **Step 3: Implement `audio-mode.ts`**

```ts
export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';

export function parseDubbedAudioMode(value: unknown): DubbedAudioMode | null {
  if (value === undefined) return 'dubbed_only';
  return value === 'dubbed_only' || value === 'duck_original' || value === 'separated_background'
    ? value
    : null;
}
```

- [ ] **Step 4: Implement provider contract and unavailable default**

Use the exact types from the spec. The unavailable provider's `separate()` must throw a stable provider error instead of returning a fake artifact.

```ts
export class DialogueSeparationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class UnavailableDialogueSeparationProvider implements DialogueSeparationProvider {
  async capabilities() { return { configured: false, provider: null, backgroundStem: false, dialogueStem: false, qualification: 'unavailable' as const }; }
  async separate(): Promise<never> {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Dialogue separation provider is unavailable.');
  }
}
```

- [ ] **Step 5: Implement owner-scoped `AudioStemRepository`**

Validate object keys before `complete`:

```ts
const prefix = `projects/${projectId}/stems/${sourceGeneration}/${provider}/`;
if (!objectKey.startsWith(prefix)) throw new Error('Audio stem object key is outside the project/source generation.');
```

`latestCompleted` must join `projects` and filter by user, project, exact current generation, `kind='background'`, provider, `status='completed'`.

- [ ] **Step 6: Run GREEN tests and commit**

```bash
npx vitest run worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
git add worker/src/domain/audio-mode.ts worker/src/db/audio-stems.ts worker/src/services/separation worker/test/audio-stems.test.ts worker/test/dialogue-separation-provider.test.ts
git commit -m "feat(phase4d): add separation provider and stem contracts"
```

---

### Task 3: Extend media processor and FFmpeg container validation

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`
- Modify: `containers/ffmpeg/server.mjs`

**Interfaces:**
- Consumes: `DubbedAudioMode` from Task 2.
- Produces: `RenderExportOptions { targetLanguage, exportId, audioMode?, backgroundObjectKey? }`.
- Produces container input contract with `audioMode` and optional `backgroundObjectKey`.

- [ ] **Step 1: Add RED container validation tests**

Test these cases:

```js
assert.equal(validateRenderExportInput({ ...base, audioMode: 'duck_original' }).audioMode, 'duck_original');
assert.throws(() => validateRenderExportInput({ ...base, audioMode: 'bogus' }), /Invalid audioMode/);
assert.throws(() => validateRenderExportInput({ ...base, audioMode: 'separated_background' }), /backgroundObjectKey/);
assert.throws(() => validateRenderExportInput({
  ...base,
  audioMode: 'separated_background',
  backgroundObjectKey: 'projects/other/stems/1/mock/background.wav',
}), /cross-project background stem/);
```

- [ ] **Step 2: Run RED container tests**

```bash
node --test containers/ffmpeg/render-export.test.mjs
```

Expected: FAIL because audio-mode validation is absent.

- [ ] **Step 3: Extend `RenderExportOptions` and container request body**

```ts
export type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  audioMode?: DubbedAudioMode;
  backgroundObjectKey?: string;
};
```

Only include `backgroundObjectKey` when mode is `separated_background`.

- [ ] **Step 4: Add strict container validation**

Rules:

```js
const audioMode = input.audioMode ?? 'dubbed_only';
if (!['dubbed_only','duck_original','separated_background'].includes(audioMode)) throw new Error('Invalid audioMode.');
if (audioMode === 'separated_background' && typeof input.backgroundObjectKey !== 'string') throw new Error('backgroundObjectKey is required.');
if (audioMode !== 'separated_background' && input.backgroundObjectKey !== undefined) throw new Error('backgroundObjectKey is only valid for separated_background.');
```

For separated mode require prefix `projects/${projectId}/stems/`.

- [ ] **Step 5: Update server fetch staging**

For separated mode, fetch the background stem into a local temp file after source validation and before FFmpeg invocation. Do not fetch any background object for other modes.

- [ ] **Step 6: Run tests and commit**

```bash
node --test containers/ffmpeg/render-export.test.mjs
npx vitest run worker/test/media-container.test.ts
git add worker/src/services/media/types.ts worker/src/services/media/container.ts containers/ffmpeg/render-export.mjs containers/ffmpeg/render-export.test.mjs containers/ffmpeg/server.mjs
git commit -m "feat(phase4d): extend media render audio contract"
```

---

### Task 4: Implement deterministic `duck_original` and `separated_background` FFmpeg graphs

**Files:**
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`
- Test: `tests/render-export-duration.test.mjs`

**Interfaces:**
- Consumes validated `audioMode`, source path, optional background path, and canonical clips.
- Produces deterministic FFmpeg args for all three modes.

- [ ] **Step 1: Write RED filter-graph tests**

Assert:

- `dubbed_only` still contains `anullsrc` and does not map `[0:a]`.
- `duck_original` includes source audio normalization and a volume expression representing exact `-18 dB` duck windows.
- overlapping/adjacent windows merge before expression generation.
- `separated_background` uses background input and does not mix original source audio.

Expose a pure helper for tests:

```js
export function mergeDialogueWindows(clips, attackMs = 80, releaseMs = 120) { /* implementation in GREEN */ }
```

Expected merged range for clips `[1000,2000]` and `[1950,2500]` is `[920,2620]` after attack/release expansion and clamping at zero.

- [ ] **Step 2: Run RED tests**

```bash
node --test containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
```

- [ ] **Step 3: Implement deterministic window merge and gain constant**

```js
export const DUCK_GAIN_DB = -18;
export const DUCK_ATTACK_MS = 80;
export const DUCK_RELEASE_MS = 120;
export const DUCK_GAIN_LINEAR = 10 ** (DUCK_GAIN_DB / 20);
```

Merge sorted expanded intervals when `next.startMs <= current.endMs`.

- [ ] **Step 4: Build three explicit render branches**

`dubbed_only`: preserve current graph unchanged.

`duck_original`: first input remains source media. Normalize `[0:a]` to 48 kHz stereo, apply bounded volume automation from merged canonical dialogue windows, then `amix` with delayed/tempo-fitted dubbed clips.

`separated_background`: use staged background stem as the audio bed; never include `[0:a]` in the final mix.

All modes retain `-map 0:v:0?`, AAC 48 kHz stereo, project-duration `-t`, and current video encoding.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
node --test containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
git add containers/ffmpeg/render-export.mjs containers/ffmpeg/render-export.test.mjs tests/render-export-duration.test.mjs
git commit -m "feat(phase4d): mix source ambience and separated backgrounds"
```

---

### Task 5: Export API audio-mode validation, persistence, and capability gate

**Files:**
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/db/project-exports.ts`
- Modify: `worker/test/multilanguage-export-route.test.ts`
- Modify: `worker/test/project-exports.test.ts`

**Interfaces:**
- Consumes: `parseDubbedAudioMode`, `DialogueSeparationProvider.capabilities()`.
- Produces workflow params with `audioMode`.
- Produces API DTOs whose export attempt includes resolved `audioMode`.

- [ ] **Step 1: Write RED route tests**

Cases:

```ts
// omitted -> dubbed_only
await post('/projects/p1/exports/ja', { output: 'dubbed' });
expect(created.audioMode).toBe('dubbed_only');

// invalid
expect(await post(..., { output: 'dubbed', audioMode: 'fake' })).toMatchStatus(400, 'AUDIO_MODE_INVALID');

// subtitle + non-default mode rejected
expect(await post(..., { output: 'subtitles', audioMode: 'duck_original' })).toMatchStatus(400, 'AUDIO_MODE_INVALID');

// separated unavailable/unqualified fail before export/job/workflow side effects
```

Batch test: one `audioMode` is applied to every dubbed target attempt.

- [ ] **Step 2: Run RED route tests**

```bash
npx vitest run worker/test/multilanguage-export-route.test.ts worker/test/project-exports.test.ts
```

- [ ] **Step 3: Add route dependency and capability validator**

Add:

```ts
makeSeparation?: (env: Env) => DialogueSeparationProvider;
```

Default to `new UnavailableDialogueSeparationProvider()`.

Capability gate:

```ts
if (audioMode === 'separated_background') {
  const caps = await makeSeparation(env).capabilities();
  if (!caps.configured || caps.qualification === 'unavailable') return DIALOGUE_SEPARATION_UNAVAILABLE;
  if (caps.qualification !== 'qualified' || !caps.backgroundStem) return DIALOGUE_SEPARATION_UNQUALIFIED;
}
```

Run this after ownership/target validation but before rate-limit consumption and before creating export/job/workflow side effects.

- [ ] **Step 4: Persist and forward audio mode**

Extend `launchValidated(..., audioMode)`; `ProjectExportRepository.create(...)` stores it; Workflow params include `audioMode`.

Legacy `POST /:id/export` always uses `dubbed_only`.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
npx vitest run worker/test/multilanguage-export-route.test.ts worker/test/project-exports.test.ts
git add worker/src/routes/export.ts worker/src/db/project-exports.ts worker/test/multilanguage-export-route.test.ts worker/test/project-exports.test.ts
git commit -m "feat(phase4d): admit explicit dubbed audio modes"
```

---

### Task 6: Workflow stem reuse, provider idempotency, cancellation, and usage metering

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/exportWorkflow.ts`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/test/exportPipeline.test.ts`
- Modify: `worker/test/usage-repository.test.ts`

**Interfaces:**
- Consumes: current `Project.sourceGeneration`, `AudioStemRepository`, `DialogueSeparationProvider`.
- Produces render options with `backgroundObjectKey` only for `separated_background`.
- Produces usage kind `dialogue_separation_second`.

- [ ] **Step 1: Write RED workflow tests**

Cover:

1. `duck_original` never calls separation provider and renders with `{ audioMode: 'duck_original' }`.
2. separated mode with an existing completed current-generation stem reuses it and never calls provider.
3. first separated export calls provider once, persists stem, records started/completed usage, renders with returned background key.
4. second language export for the same generation/provider reuses the stem.
5. completed durable stem + missing completed usage recovers accounting without provider rerun.
6. provider failure marks export/job failed and does not render/publish.
7. cancellation is checked immediately before provider, before render, and before publish.
8. invalid/cross-project provider result fails with `DIALOGUE_SEPARATION_ARTIFACT_INVALID`.

- [ ] **Step 2: Run RED workflow tests**

```bash
npx vitest run worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
```

- [ ] **Step 3: Add usage kind without inventing cost**

```ts
export type UsageKind =
  | 'asr_audio_second'
  | 'translation_character'
  | 'tts_audio_second'
  | 'render_second'
  | 'dialogue_separation_second';
```

Add `dialogueSeparationSeconds` to `UsageTotals` and aggregate it only for completed events.

- [ ] **Step 4: Extend normalized workflow params**

```ts
type NormalizedExportParams = {
  // existing fields
  audioMode: DubbedAudioMode;
};
```

Legacy normalizes to `dubbed_only`.

- [ ] **Step 5: Implement `resolveBackgroundStem` helper**

Algorithm:

```ts
const caps = await deps.separation.capabilities();
const provider = caps.provider?.trim();
// require configured + qualified + backgroundStem + provider name
const existing = await deps.stems.latestCompleted(projectId, userId, sourceGeneration, 'background', provider);
if (existing) return existing.objectKey;
await ensureActive();
const operationKey = `project:${projectId}:source:${sourceGeneration}:dialogue-separation:${provider}`;
const started = await usage.getByOperation(operationKey, 'started');
const completed = await usage.getByOperation(operationKey, 'completed');
// if completed accounting exists without durable stem => fail, never rebill/rerun blindly
// otherwise record started, call provider once, validate/persist result, record completed
```

Use project duration seconds as metering units because the provider processes source media duration; `costBasis` remains zero like existing usage events.

- [ ] **Step 6: Wire repository/provider in `exportWorkflow.ts`**

Instantiate `AudioStemRepository(env.DB)`. Until a real provider is configured in a later provider-specific change, use `UnavailableDialogueSeparationProvider` as the production default; tests inject a mock qualified provider.

- [ ] **Step 7: Pass render options**

```ts
const options = params.modern ? {
  targetLanguage: params.targetLanguage,
  exportId: params.exportId!,
  audioMode: params.audioMode,
  ...(backgroundObjectKey ? { backgroundObjectKey } : {}),
} : undefined;
```

- [ ] **Step 8: Run GREEN workflow tests and commit**

```bash
npx vitest run worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
git add worker/src/workflows/exportPipeline.ts worker/src/workflows/exportWorkflow.ts worker/src/db/usage.ts worker/test/exportPipeline.test.ts worker/test/usage-repository.test.ts
git commit -m "feat(phase4d): reuse qualified separation stems in exports"
```

---

### Task 7: Cloud Studio export controls and client contract

**Files:**
- Modify: `src/features/export/batchExportApi.ts`
- Modify: `src/features/export/batchExportApi.test.ts`
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batch-export.css`
- Modify: `src/app/phase4cStudioContext.tsx`

**Interfaces:**
- Consumes: API `DubbedAudioMode` string values and separation capability state.
- Produces: selected mode included in single/batch dubbed export requests.

- [ ] **Step 1: Write RED client/UI tests**

Client:

```ts
await startBatchExport('p1', ['vi','ja'], 'dubbed', 'duck_original');
expect(fetchBody()).toEqual({ targetLanguages: ['vi','ja'], output: 'dubbed', audioMode: 'duck_original' });
```

UI assertions:

- labels exactly `Dubbed voice only`, `Keep original ambience (duck dialogue)`, `Separated background stem`;
- separated option disabled when capability is unavailable or unqualified;
- duck option remains available for dubbed output;
- selector hidden/disabled for subtitles;
- UI copy never calls ducking AI separation.

- [ ] **Step 2: Run RED UI/client tests**

```bash
npx vitest run src/features/export/batchExportApi.test.ts src/features/export/BatchExportPanel.test.tsx
```

- [ ] **Step 3: Extend API helpers**

```ts
export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';

export function startLanguageExport(projectId, targetLanguage, output, audioMode = 'dubbed_only') {
  const body = output === 'dubbed' ? { output, audioMode } : { output };
  // existing apiFetch
}
```

Apply identical semantics to batch export.

- [ ] **Step 4: Add export audio-treatment selector**

Place it in `BatchExportPanel`, not segment inspector. `separated_background` must render disabled with an explicit reason when not qualified. Keep current voice-provider guards independent from separation capability.

- [ ] **Step 5: Hold selected mode in studio context**

Default state is `dubbed_only`. Preserve selection when target language changes; reset/ignore it when output is subtitles. Retry of a failed dubbed target must reuse the same selected mode.

- [ ] **Step 6: Run GREEN tests and commit**

```bash
npx vitest run src/features/export/batchExportApi.test.ts src/features/export/BatchExportPanel.test.tsx
git add src/features/export src/app/phase4cStudioContext.tsx
git commit -m "feat(phase4d): expose honest audio treatment controls"
```

---

### Task 8: Acceptance guards, docs, and full verification

**Files:**
- Modify: `tests/phase4d-audio-separation-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- Acceptance guard locks all cross-layer requirements before PR merge.

- [ ] **Step 1: Expand acceptance test to RED**

Assert exact source shapes/paths:

```js
assert.match(audioModeSource, /ducked_original|duck_original/); // use exact canonical token `duck_original`
assert.match(migration, /CREATE TABLE project_audio_stems/);
assert.match(renderSource, /DUCK_GAIN_DB\s*=\s*-18/);
assert.match(renderSource, /DUCK_ATTACK_MS\s*=\s*80/);
assert.match(renderSource, /DUCK_RELEASE_MS\s*=\s*120/);
assert.match(exportRoute, /DIALOGUE_SEPARATION_UNAVAILABLE/);
assert.match(exportRoute, /DIALOGUE_SEPARATION_UNQUALIFIED/);
assert.doesNotMatch(uiSource, /AI separation.*duck/i);
```

Also assert `.github/workflows/deploy-cloudflare.yml` remains absent and GitHub workflow deploy remains dry-run only.

- [ ] **Step 2: Wire acceptance into verify and run RED**

Append `tests/phase4d-audio-separation-acceptance.test.mjs` to `verify:deploy-config`.

Run:

```bash
npm run verify:deploy-config
```

Expected: RED until docs/source from Tasks 1-7 satisfy every assertion.

- [ ] **Step 3: Update README and deployment status**

Document:

- `dubbed_only` compatibility mode;
- `duck_original` as deterministic preservation, not AI separation;
- true separated background is capability-gated and production provider is currently unavailable unless explicitly configured/qualified;
- stem reuse is project/source-generation scoped;
- source/CI qualification does not equal production runtime qualification;
- Cloudflare Workers Builds remains sole production deployment lane.

- [ ] **Step 4: Run full verification**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: all source guards, Vitest suite, TypeScript/Vite build, migration build helper, and Wrangler dry-run PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/phase4d-audio-separation-acceptance.test.mjs package.json README.md docs/deployment-status.md
git commit -m "test(phase4d): qualify audio separation source contract"
```

---

### Task 9: Exact-head review, PR, merge, and post-merge verification

**Files:**
- No feature-code changes unless review finds a real issue.

**Interfaces:**
- Produces final merge SHA and post-merge CI evidence.

- [ ] **Step 1: Refetch live `main` and compare drift**

```bash
git fetch origin main
git merge-base HEAD origin/main
git diff --name-only $(git merge-base HEAD origin/main)..origin/main
```

If `main` moved, non-force merge latest `main` into the feature branch; resolve only actual overlaps and rerun full exact-head verification.

- [ ] **Step 2: Run final exact-head verification**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Record exact feature SHA. Do not claim green from an older SHA.

- [ ] **Step 3: Review high-risk seams**

Check:

- migration numbers unique and `0011` forward-only;
- source generation increments only on successful source replacement;
- legacy omitted mode remains `dubbed_only`;
- `duck_original` never touches separation provider or provider usage;
- separated mode never silently downgrades;
- stem key validation is project/source-generation scoped;
- same stem is reusable across target languages;
- concrete share behavior remains keyed by export attempt;
- dedicated batch export limiter remains intact;
- no GitHub production deploy path introduced.

- [ ] **Step 4: Open final PR**

Title:

```text
feat: add Phase 4D background dialogue treatment
```

Body must state exact head SHA, exact CI run(s), three audio modes, provider qualification boundary, forward migration `0011`, and `Production runtime remains UNQUALIFIED`.

- [ ] **Step 5: Require fresh PR CI on exact head**

Do not merge while PR checks are pending, failed, stale, or while review threads are unresolved.

- [ ] **Step 6: Merge with expected head SHA**

Use non-force merge with `expected_head_sha=<exact tested feature SHA>`.

- [ ] **Step 7: Verify live main and post-merge CI**

Fetch `main`; require it to point at the returned merge SHA. Then require the push CI run on that exact merge SHA to finish `completed/success`, including verify/build, Wrangler dry-run, CJK screenshot and artifact steps.

- [ ] **Step 8: Do not manually deploy production**

Cloudflare Workers Builds may react to the `main` merge through the repository's normal deployment lane. Do not invoke a manual production deploy and do not call production runtime qualified without a separate real-media/provider fixture qualification.
