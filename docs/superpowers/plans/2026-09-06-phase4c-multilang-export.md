# Phase 4C Multi-language Batch Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, backward-compatible multi-language translation/dubbing/export persistence and batch export orchestration for `vi`, `en`, `ja`, `ko`, and `zh` while keeping existing omitted-language behavior Vietnamese.

**Architecture:** Introduce a focused target-aware persistence module beside the legacy project/segment repositories, then extend export orchestration with explicit `targetLanguage` identity and a bounded batch fan-out route. Legacy Vietnamese fields remain mirrors and existing endpoints remain valid; non-`vi` state lives only in new tables. Sharing binds to one concrete export variant, while the existing Vietnamese share path remains compatible.

**Tech Stack:** Cloudflare Workers, Hono, D1, R2, Cloudflare Workflows, Cloudflare Rate Limiting, TypeScript, React/Vite, Vitest, Node test, FFmpeg Container boundary.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4c-multilang-export-design.md`

## Global Constraints

- Supported target languages are exactly `vi`, `en`, `ja`, `ko`, `zh`.
- A batch request contains 1–4 distinct target languages.
- Omitted target language means `vi`.
- `projects.target_language` and legacy Vietnamese project/segment fields remain intact.
- Non-`vi` writes never overwrite legacy Vietnamese fields.
- Existing Phase 3C rate-limit lanes and Phase 4B voice-clone lane remain unchanged.
- Add `RATE_LIMIT_BATCH_EXPORT` namespace `31007`, `2/min`.
- Phase 3B usage remains authoritative; batch admission itself writes no usage.
- Production deployment occurs only after source/PR/post-merge qualification; no bypass of Cloudflare credential or runtime failures.

---

## File Map

**Create**
- `migrations/0009_multilang_exports.sql` — target-aware D1 tables and indexes.
- `worker/src/domain/target-language.ts` — bounded language parsing/defaulting helpers.
- `worker/src/db/multilang.ts` — `MultilangStore`/`MultilangRepository` for project targets, target translations, target dubs, and export variants.
- `worker/src/routes/project-targets.ts` — owner-scoped GET/PUT target configuration.
- `worker/src/routes/batch-export.ts` — bounded batch admission/fan-out.
- `src/features/export/multilangExportApi.ts` — target/export API client types and calls.
- `src/features/export/MultiLanguageExportPanel.tsx` — compact target selector/status UI.
- `src/features/export/multilang-export.css` — isolated panel presentation.
- `tests/phase4c-multilang-export-acceptance.test.mjs` — source/config safety acceptance.
- Focused tests under `worker/test/` and `src/features/export/` as listed below.

**Modify**
- `package.json` — wire 4C acceptance into `verify:deploy-config` without removing prior gates/dependencies.
- `wrangler.jsonc` — add `RATE_LIMIT_BATCH_EXPORT` only.
- `worker/src/env.ts` — add `RATE_LIMIT_BATCH_EXPORT` binding.
- `worker/src/security/rate-limit.ts` — add `batch-export` operation.
- `worker/src/app.ts` — mount project-target and batch-export routes.
- `worker/src/routes/export.ts` — accept optional target language and variant-aware reads while retaining legacy endpoints.
- `worker/src/workflows/ExportWorkflow.ts` — pass target language/export id into pipeline.
- `worker/src/workflows/exportPipeline.ts` — target-scoped state/object keys/idempotency/mirroring.
- `worker/src/routes/translation.ts` and `worker/src/routes/segments.ts` — target-aware translate/regenerate paths and invalidation entry points.
- `worker/src/db/segments.ts` and `worker/src/db/speakers.ts` — invoke target-aware invalidation on source/voice mutations through injected/adjacent store boundaries.
- `worker/src/db/shares.ts` and `worker/src/routes/shares.ts` — persist/use concrete export variant with Vietnamese compatibility fallback.
- `src/app/StudioShell.tsx` — mount multilingual export panel without replacing the Vietnamese editor.
- `docs/deployment-status.md`, `README.md` — source qualification and production fixture boundary.

---

### Task 1: RED acceptance and target-language domain contract

**Files:**
- Create: `tests/phase4c-multilang-export-acceptance.test.mjs`
- Create: `worker/src/domain/target-language.ts`
- Create: `worker/test/target-language.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `export type TargetLanguage = 'vi' | 'en' | 'ja' | 'ko' | 'zh'`
- Produces: `SUPPORTED_TARGET_LANGUAGES: readonly TargetLanguage[]`
- Produces: `parseTargetLanguage(value: unknown, fallback?: TargetLanguage): TargetLanguage`
- Produces: `parseBatchTargetLanguages(value: unknown): TargetLanguage[]`

- [ ] **Step 1: Write failing acceptance/source test** that reads migration/config/new modules and asserts exact language set, max batch size, migration `0009`, binding `31007`, target-scoped object-key markers, concrete export-variant share marker, and deployment-status qualification text.

```js
assert.deepEqual([...SUPPORTED].sort(), ['en', 'ja', 'ko', 'vi', 'zh']);
assert.match(wrangler, /RATE_LIMIT_BATCH_EXPORT/);
assert.match(wrangler, /"namespace_id": "31007"/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS project_exports/);
```

- [ ] **Step 2: Wire acceptance into `verify:deploy-config` and push RED exact head.**

Run: `npm run verify:deploy-config`
Expected: FAIL because `0009_multilang_exports.sql`, target domain/store/routes/UI do not yet exist.

- [ ] **Step 3: Add target-language unit RED tests.**

```ts
expect(parseTargetLanguage(undefined)).toBe('vi');
expect(() => parseTargetLanguage('fr')).toThrow('Unsupported target language');
expect(parseBatchTargetLanguages(['ja','vi','ja'])).toEqual(['ja','vi']);
expect(() => parseBatchTargetLanguages(['vi','en','ja','ko','zh'])).toThrow('at most 4');
```

- [ ] **Step 4: Implement minimal pure target-language module and make unit tests GREEN.**

- [ ] **Step 5: Commit RED acceptance + domain helper.**

---

### Task 2: D1 target-aware persistence

**Files:**
- Create: `migrations/0009_multilang_exports.sql`
- Create: `worker/src/db/multilang.ts`
- Create: `worker/test/multilang-persistence.test.ts`

**Interfaces:**

```ts
export type TargetTranslation = {
  segmentId: string; projectId: string; targetLanguage: TargetLanguage;
  translatedText: string; translationEngine: string; translationStatus: string;
  contextRevision: number | null; sourceSegmentVersion: number; version: number;
};
export type TargetDub = {
  segmentId: string; projectId: string; targetLanguage: TargetLanguage;
  status: string; objectKey: string | null; voiceProvider: string | null;
  voiceId: string | null; translationVersion: number; segmentVersion: number;
  durationMs: number | null;
};
export type ExportVariant = {
  id: string; projectId: string; targetLanguage: TargetLanguage;
  status: 'queued'|'running'|'failed'|'completed'|'cancelled';
  objectKey: string | null; jobId: string | null; errorCode: string | null;
  generation: number;
};
```

`MultilangStore` methods:

```ts
listTargets(projectId,userId): Promise<TargetLanguage[]>;
replaceTargets(projectId,userId,targets:TargetLanguage[]): Promise<TargetLanguage[]>;
getTranslation(projectId,segmentId,userId,target): Promise<TargetTranslation|null>;
upsertTranslation(input: TargetTranslation & {userId:string}): Promise<TargetTranslation>;
getDub(projectId,segmentId,userId,target): Promise<TargetDub|null>;
upsertDub(input: TargetDub & {userId:string}): Promise<TargetDub>;
invalidateSegmentAllTargets(projectId,segmentId,userId): Promise<void>;
invalidateSegmentTarget(projectId,segmentId,userId,target): Promise<void>;
invalidateSpeakerAllTargets(projectId,speakerId,userId): Promise<void>;
createExport(input:{id:string;projectId:string;userId:string;targetLanguage:TargetLanguage;jobId:string;generation:number}): Promise<ExportVariant>;
getExport(projectId,exportId,userId): Promise<ExportVariant|null>;
listExports(projectId,userId): Promise<ExportVariant[]>;
setExportRunning(...): Promise<void>;
completeExport(projectId,exportId,userId,objectKey): Promise<void>;
failExport(projectId,exportId,userId,errorCode): Promise<void>;
invalidateExportsForTarget(projectId,userId,target): Promise<void>;
```

- [ ] **Step 1: Write repository/migration tests** for ownership hiding, exact constraints, `vi` logical default, target isolation, and invalidation.
- [ ] **Step 2: Run focused tests; expected RED** due absent migration/repository.
- [ ] **Step 3: Implement migration** with CHECK constraints (`enabled IN (0,1)`, exact language set) and indexes.
- [ ] **Step 4: Implement repository using project ownership joins** so cross-user/missing resolves null/not-found rather than leaking existence.
- [ ] **Step 5: Run focused tests GREEN and commit.**

---

### Task 3: Project target routes and batch admission lane

**Files:**
- Create: `worker/src/routes/project-targets.ts`
- Create: `worker/src/routes/batch-export.ts`
- Create: `worker/test/project-target-routes.test.ts`
- Create: `worker/test/batch-export-routes.test.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/security/rate-limit.ts`
- Modify: `worker/src/app.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**

`createProjectTargetRoutes({ makeProjects?, makeMultilang? })` mounts `/:id/targets`.

`createBatchExportRoutes({ makeProjects?, makeJobs?, makeMultilang? })` mounts `/:id/exports/batch` and returns:

```ts
{ status:'queued', targets: Array<{targetLanguage:TargetLanguage; exportId:string; jobId:string; workflowId:string}> }
```

Workflow params for each child include `{ projectId, userId, jobId, exportId, targetLanguage, requestId }`.

- [ ] **Step 1: Write route RED tests** proving ownership -> body parse/validation/dedupe -> limiter -> durable creation/workflow order.
- [ ] **Step 2: Add `RATE_LIMIT_BATCH_EXPORT` to Env/rate-limit/wrangler.**
- [ ] **Step 3: Implement GET/PUT targets with `vi` always available.**
- [ ] **Step 4: Implement batch route with 1–4 deduplicated valid targets and no usage writes.**
- [ ] **Step 5: Add compensation:** if a child workflow fails to start, mark only that child export/job failed; already-started siblings remain queued/running.
- [ ] **Step 6: Focused tests GREEN and commit.**

---

### Task 4: Target-aware export pipeline

**Files:**
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/test/export-pipeline.test.ts`
- Create: `worker/test/multilang-export-pipeline.test.ts`
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`

**Interfaces:**

```ts
export type ExportWorkflowParams = {
  projectId:string; userId:string; jobId:string; requestId?:string;
  exportId?:string; targetLanguage?:TargetLanguage;
};
```

`runExportPipeline()` normalizes omitted target to `vi`; new target-aware dependencies are exposed under `multilang?: MultilangStore` while legacy stores remain for `vi` compatibility.

Audio keys:
`projects/${projectId}/dubbed/${target}/${segmentId}/${version}.mp3`

Export key validation accepts only:
`projects/${projectId}/exports/${target}/${exportId}.mp4`
for target-aware operations; legacy `vi` calls remain compatible with existing processor response until the media adapter is updated in the same task.

Usage operation keys include target:
`job:${jobId}:retry:${retryCount}:${target}:${stage}:${item}:${provider}`.

- [ ] **Step 1: RED pipeline tests** for `ja` isolation, `vi` mirroring, target-specific idempotency, sibling preservation, and provider language propagation.
- [ ] **Step 2: Extend workflow params and dependency interfaces.**
- [ ] **Step 3: Load target translation/dub state for non-`vi`; use legacy segment fields only for `vi` mirror/compatibility.**
- [ ] **Step 4: Generate TTS with `language: targetLanguage`; persist target dub and meter actual TTS seconds with target-scoped operation key.**
- [ ] **Step 5: Render target-specific artifact; persist `project_exports`; mirror `projects.export_object_key` only for `vi`.**
- [ ] **Step 6: Failure marks only the current export variant failed; it must not erase completed sibling targets.**
- [ ] **Step 7: Focused pipeline/container tests GREEN and commit.**

---

### Task 5: Target-aware translation and invalidation

**Files:**
- Modify: `worker/src/routes/translation.ts`
- Modify: `worker/src/routes/segments.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/db/speakers.ts`
- Create: `worker/test/multilang-invalidation.test.ts`
- Create: `worker/test/multilang-translation-routes.test.ts`

**Interfaces:**

Optional request property:
```ts
{ targetLanguage?: TargetLanguage }
```
Omitted => `vi`.

- [ ] **Step 1: RED tests for invalidation matrix.** Source/timing/structural segment mutation invalidates all target translation/dub/export state; one-target translation mutation invalidates only that target dub/export; speaker voice change invalidates speaker dubs and dependent exports across targets.
- [ ] **Step 2: RED translation route tests** proving unsupported targets fail before rate-limit/provider/usage and Phase 4A context snapshot remains per operation.
- [ ] **Step 3: Implement target-aware persistence calls while retaining legacy `vi` fields.**
- [ ] **Step 4: Inject/use `MultilangStore` from segment/speaker mutation boundaries without restructuring unrelated repository code.**
- [ ] **Step 5: Focused tests GREEN and commit.**

---

### Task 6: Variant-aware sharing and owner media reads

**Files:**
- Modify: `worker/src/db/shares.ts`
- Modify: `worker/src/routes/shares.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/test/share-routes.test.ts`
- Modify: `worker/test/public-share-route.test.ts`
- Create: `worker/test/multilang-share.test.ts`
- Migration change remains in `0009_multilang_exports.sql` if an `export_id` FK column is added to `export_shares` there.

**Interfaces:**

New share create input accepts `exportId?: string`; new UI always provides it. Omitted export id resolves only to the current valid Vietnamese completed export for compatibility.

Owner variant media route:
`GET /api/projects/:id/exports/:exportId/media`.
Legacy `GET /api/projects/:id/export/media` remains Vietnamese.

- [ ] **Step 1: RED tests** for concrete variant binding, incomplete/cross-project export rejection, legacy Vietnamese fallback, Range parity, token/revocation/no-referrer unchanged.
- [ ] **Step 2: Persist export variant reference server-side; do not encode authority in token.**
- [ ] **Step 3: Stream selected variant through existing `streamMediaObject`.**
- [ ] **Step 4: Focused sharing/media tests GREEN and commit.**

---

### Task 7: Studio multi-language export surface

**Files:**
- Create: `src/features/export/multilangExportApi.ts`
- Create: `src/features/export/multilangExportApi.test.ts`
- Create: `src/features/export/MultiLanguageExportPanel.tsx`
- Create: `src/features/export/MultiLanguageExportPanel.test.tsx`
- Create: `src/features/export/multilang-export.css`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`

**Interfaces:**

```ts
export type TargetStatus = { targetLanguage: TargetLanguage; exportId:string; status:string; errorCode?:string|null };
export function fetchProjectTargets(projectId:string): Promise<TargetLanguage[]>;
export function saveProjectTargets(projectId:string, targets:TargetLanguage[]): Promise<TargetLanguage[]>;
export function startBatchExport(projectId:string, targets:TargetLanguage[]): Promise<{status:'queued';targets:TargetStatus[]}>;
export function fetchExportVariants(projectId:string): Promise<TargetStatus[]>;
```

- [ ] **Step 1: RED API tests** for request payload/default/error handling.
- [ ] **Step 2: RED component tests** for five chips, max-four selection, per-target independent states, unavailable/error labels, completed sibling preserved.
- [ ] **Step 3: Implement API client and compact panel.**
- [ ] **Step 4: Mount panel beside existing export/sharing controls without duplicating full transcript editors.**
- [ ] **Step 5: Focused frontend tests GREEN and commit.**

---

### Task 8: Documentation, full verification, review, merge, deploy

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment-status.md`
- Modify acceptance/safety guards only when an existing exact-source guard is stale against the additive 4C contract; do not weaken prior invariants.

- [ ] **Step 1: Update docs** to state source/CI support for bounded multi-language export and exact production fixture requirements; do not claim runtime PASS before deploy/fixture evidence.
- [ ] **Step 2: Run full verification**:

```bash
npm run verify:deploy-config
npm test
npm run build
npx wrangler deploy --dry-run
```

Expected: all PASS; CI also captures the existing 1448×1086 and responsive reference screenshots.

- [ ] **Step 3: Review feature diff against live `main`; reconcile any base drift non-force and rerun exact-head verification.**
- [ ] **Step 4: Open PR; require exact-head/merge-ref CI GREEN and no unresolved blocker.**
- [ ] **Step 5: Merge with expected feature head and verify exact merge SHA on `main`.**
- [ ] **Step 6: Require post-merge CI GREEN on exact merge SHA.**
- [ ] **Step 7: Trigger the existing manual production deploy workflow only after post-merge GREEN.** Do not change secrets or bypass credential checks.
- [ ] **Step 8: Verify deploy workflow result and `/api/ready`.** If Cloudflare Containers authentication still returns Unauthorized/missing Containers Write, record production as BLOCKED/UNQUALIFIED and stop; do not repeatedly redeploy. If deploy succeeds, run only the repository's existing safe readiness verification and record deployment provenance. Do not claim real multi-language provider/media qualification unless a real authorized fixture has actually passed.
