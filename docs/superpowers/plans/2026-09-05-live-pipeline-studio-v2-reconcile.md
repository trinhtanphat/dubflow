# Live Pipeline × Studio Pro V2 Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase the proven live dubbing pipeline onto the current Studio Pro V2.1 `main`, preserve the new shell/accessibility/responsive UX, and reconnect upload, Cloudflare processing, hydration, transcript persistence, and retranslation end-to-end.

**Architecture:** Studio Pro V2.1 remains the composition authority. Backend/runtime/service/API/helper files are ported from exact GREEN pipeline head `72bd05b3ba56a0058792a9b1f26146f1c7330fa0`, while conflict-bearing UI/config files are manually reconciled under TDD. `StudioShell` becomes the live orchestration boundary; `StudioTopbar` only receives truthful cloud progress/status props and existing shell contracts remain intact.

**Tech Stack:** React 19, TypeScript 5.8, Hono, Vite 7, Vitest 3, Cloudflare Workers, Workflows, Containers, R2, D1, Workers AI, Wrangler 4.45, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-live-pipeline-studio-v2-reconcile-design.md`

## Global Constraints

- Preserve Studio Pro V2.1 shell, mobile drawers, accessibility primitives, design tokens, status badges, tooltips, and current responsive behavior.
- Do not overwrite `App.tsx`, `StudioShell.tsx`, or `StudioTopbar.tsx` with their older pipeline-branch versions.
- Port source-preserving backend/runtime files from exact pipeline head `72bd05b3ba56a0058792a9b1f26146f1c7330fa0`.
- Maximum source media remains 5 GB and 3 hours.
- Never buffer the complete uploaded video or extracted audio in Worker memory.
- FFmpeg emits bounded 5-minute audio chunks; ASR buffers only one chunk at a time.
- Persisted D1 project/job/segment state is authoritative after cloud processing begins.
- Poll project jobs no faster than every 2 seconds and stop on terminal state or unmount.
- Compare translation mode never mutates D1 until the user explicitly applies one choice.
- Unsupported TTS preview, voice regeneration/cloning, visual lip-sync rendering, and final export remain capability-gated.
- Keep current Cloudflare account/domain/deployment semantics from `main`; do not restore stale account IDs or stale deploy-trigger assumptions.
- Every conflict-bearing behavior change follows RED -> GREEN TDD.
- Final merge requires exact-head GitHub Actions GREEN for `npm run verify` and `npx wrangler deploy --dry-run`.
- Production runtime PASS is separate from source CI and requires a real Cloudflare fixture run.

---

### Task 1: Port the Proven Backend Runtime and Preserve Current Deployment Configuration

**Files:**
- Create: `containers/ffmpeg/Dockerfile`
- Create: `containers/ffmpeg/server.mjs`
- Create: `worker/src/app.ts`
- Create: `worker/src/cloudflare/workflows-runtime.d.ts`
- Create: `worker/src/containers/FfmpegContainer.ts`
- Create: `worker/src/db/jobs.ts`
- Create: `worker/src/routes/jobs.ts`
- Create: `worker/src/services/media/container.ts`
- Create: `worker/src/workflows/DubbingWorkflow.ts`
- Create: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/cloudflare/r2.ts`
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/domain/segment.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/services/media/types.ts`
- Modify: `package.json`
- Modify: `wrangler.jsonc`
- Modify: `tests/deploy-config.test.mjs`
- Port tests: `worker/test/media-container.test.ts`, `worker/test/jobs.test.ts`, `worker/test/asr-persistence.test.ts`, `worker/test/dubbing-workflow.test.ts`, `worker/test/process-route.test.ts`
- Reconcile existing tests: `worker/test/health.test.ts`, `worker/test/process-boundary.test.ts`, `worker/test/projects.test.ts`, `worker/test/provider-contracts.test.ts`, `worker/test/uploads.test.ts`

**Interfaces:**
- Produces `FFMPEG_CONTAINER` durable-object/container binding.
- Produces `DUBBING_WORKFLOW` binding with workflow params `{ projectId: string; userId: string; jobId: string }`.
- Produces project-scoped durable jobs and `GET /api/projects/:id/jobs/:jobId`.
- `POST /api/projects/:id/process` returns `202 { jobId, workflowId, status: 'queued' }`.
- `ContainerMediaProcessor.extractAudioChunks(projectId, objectKey)` returns bounded `AudioChunk[]`.
- `SegmentStore.replaceFromAsr(projectId, userId, segments)` atomically replaces persisted transcript rows.

- [ ] **Step 1: Create the reconciliation branch from exact current main and record baseline SHA**

Run via GitHub connector equivalent of:

```bash
git switch -c feat/live-pipeline-studio-v2-reconcile 665a6369ae61cae979a71e70d8b7efcad4335066
```

Expected: branch base is exactly `665a6369ae61cae979a71e70d8b7efcad4335066`.

- [ ] **Step 2: Run baseline CI before production mutation**

Trigger through the branch push/docs commits and inspect the Actions run.

Expected: current Studio Pro V2.1 baseline passes `npm run verify` and Wrangler dry-run before backend porting.

- [ ] **Step 3: Port exact GREEN runtime/service/test files from pipeline head**

Copy byte-for-byte from `72bd05b3ba56a0058792a9b1f26146f1c7330fa0` for files that do not exist on current `main`, including the FFmpeg container, job repository, workflow classes, media container service, and their new tests.

Do not copy old `App.tsx`, `app.css`, `StudioShell.tsx`, or topbar code.

- [ ] **Step 4: Write a RED deploy-config regression before merging `wrangler.jsonc`**

Extend `tests/deploy-config.test.mjs` with assertions equivalent to:

```js
assert.equal(config.account_id, '50afb4fd3c4c7a1f3e1bdb7f22d4af7f');
assert.ok(config.containers.some((entry) => entry.class_name === 'FfmpegContainer'));
assert.ok(config.durable_objects.bindings.some((entry) => entry.name === 'FFMPEG_CONTAINER'));
assert.ok(config.workflows.some((entry) => entry.binding === 'DUBBING_WORKFLOW' && entry.class_name === 'DubbingWorkflow'));
```

The first assertion prevents stale pipeline config from restoring the old Cloudflare account.

- [ ] **Step 5: Verify the deploy-config test is RED on current config**

Run:

```bash
npm run verify:deploy-config
```

Expected: FAIL because Container/Workflow bindings are not yet present; the account-id assertion itself must pass.

- [ ] **Step 6: Manually merge `package.json` and `wrangler.jsonc`**

Keep current main values:

```json
{
  "account_id": "50afb4fd3c4c7a1f3e1bdb7f22d4af7f",
  "routes": [{ "pattern": "yupvox.qs3d.site", "custom_domain": true }]
}
```

Add the proven runtime contracts:

```json
{
  "containers": [{
    "class_name": "FfmpegContainer",
    "image": "./containers/ffmpeg/Dockerfile",
    "max_instances": 4,
    "instance_type": "standard-1"
  }],
  "durable_objects": {
    "bindings": [{ "name": "FFMPEG_CONTAINER", "class_name": "FfmpegContainer" }]
  },
  "workflows": [{
    "binding": "DUBBING_WORKFLOW",
    "name": "dubflow-dubbing",
    "class_name": "DubbingWorkflow"
  }]
}
```

Add `@cloudflare/containers` to dependencies while retaining all current scripts, especially `verify:deploy-config` and `verify`.

- [ ] **Step 7: Reconcile shared backend files from the proven head without changing semantics**

For `env.ts`, `projects.ts`, `segments.ts`, `segment.ts`, `r2.ts`, `index.ts`, `process.ts`, and media types, merge only the pipeline contracts needed by the new files. Preserve current `/api/ready`, current account/deployment assumptions, and any Studio Pro-era route changes already on main.

- [ ] **Step 8: Run focused backend tests and dry-run**

Run:

```bash
npm test -- worker/test/media-container.test.ts worker/test/jobs.test.ts worker/test/asr-persistence.test.ts worker/test/dubbing-workflow.test.ts worker/test/process-route.test.ts
npm run typecheck
npm run verify:deploy-config
npx wrangler deploy --dry-run
```

Expected: all PASS.

- [ ] **Step 9: Commit backend reconciliation**

```bash
git add containers worker package.json wrangler.jsonc tests/deploy-config.test.mjs
git commit -m "feat: reconcile live Cloudflare dubbing runtime"
```

### Task 2: Port Frontend Cloud API and Pure Orchestration Helpers

**Files:**
- Create: `src/features/projects/jobApi.ts`
- Create: `src/features/projects/jobApi.test.ts`
- Create: `src/features/projects/jobPolling.ts`
- Create: `src/features/projects/jobPolling.test.ts`
- Create: `src/features/transcript/segmentApi.ts`
- Create: `src/features/transcript/segmentApi.test.ts`
- Create: `src/features/transcript/editorPersistence.ts`
- Create: `src/features/transcript/editorPersistence.test.ts`
- Create: `src/features/upload/cloudUploadFlow.ts`
- Create: `src/features/upload/cloudUploadFlow.test.ts`
- Create: `src/app/cloudStudio.ts`
- Create: `src/app/cloudStudio.test.ts`
- Create: `src/app/cloudJobFlow.ts`
- Create: `src/app/cloudJobFlow.test.ts`
- Create: `src/app/cloudHydration.ts`
- Create: `src/app/cloudHydration.test.ts`
- Modify: `src/features/projects/projectApi.ts`
- Modify: `src/features/translation/translationApi.ts`

**Interfaces:**

```ts
startProcessing(projectId: string): Promise<{ jobId: string; workflowId: string; status: 'queued' }>;
getJob(projectId: string, jobId: string, signal?: AbortSignal): Promise<CloudJob>;
listSegments(projectId: string): Promise<CloudSegment[]>;
patchSegment(projectId: string, segmentId: string, patch: SegmentPatch): Promise<CloudSegment>;
runCloudUpload(file: File, deps?): Promise<{ project: CloudProject; job: StartProcessingResult }>;
followCloudJob(projectId: string, jobId: string, deps?, signal?, onUpdate?): Promise<StudioProject | null>;
```

- [ ] **Step 1: Port the pure API/helper tests from exact GREEN pipeline head**

Copy the API, polling, upload-flow, hydration, and editor-persistence tests from `72bd05b3...` without modification first.

- [ ] **Step 2: Verify RED because production modules are absent on current main**

Run:

```bash
npm test -- src/features/projects/jobApi.test.ts src/features/projects/jobPolling.test.ts src/features/transcript/segmentApi.test.ts src/features/transcript/editorPersistence.test.ts src/features/upload/cloudUploadFlow.test.ts src/app/cloudStudio.test.ts src/app/cloudJobFlow.test.ts src/app/cloudHydration.test.ts
```

Expected: FAIL on missing modules/functions.

- [ ] **Step 3: Port production helper modules from exact GREEN pipeline head**

Copy the corresponding pure modules and merge only the small additions in `projectApi.ts` and `translationApi.ts`.

`retranslateSegment` must keep the typed union:

```ts
type RetranslateResult =
  | { mode: 'workers-ai' | 'google'; result: TranslationResult; segment: CloudSegment }
  | { mode: 'compare'; workersAI: TranslationResult[]; google: TranslationResult[] };
```

- [ ] **Step 4: Run the focused helper suite and typecheck GREEN**

```bash
npm test -- src/features/projects/jobApi.test.ts src/features/projects/jobPolling.test.ts src/features/transcript/segmentApi.test.ts src/features/transcript/editorPersistence.test.ts src/features/upload/cloudUploadFlow.test.ts src/app/cloudStudio.test.ts src/app/cloudJobFlow.test.ts src/app/cloudHydration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit pure frontend cloud capabilities**

```bash
git add src/features/projects src/features/transcript/segmentApi* src/features/transcript/editorPersistence* src/features/upload/cloudUploadFlow* src/features/translation/translationApi.ts src/app/cloud*.ts
git commit -m "feat: port live dubbing frontend services"
```

### Task 3: Reconcile Studio State and Upload-to-Hydration Orchestration into StudioShell

**Files:**
- Modify: `src/app/studioState.ts`
- Modify: `src/app/studioState.test.ts`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/StudioTopbar.tsx`
- Modify: `src/app/StudioTopbar.test.tsx`
- Modify: `src/features/upload/UploadPanel.tsx`
- Test: existing upload tests plus `src/app/StudioShell.test.tsx`

**Interfaces:**

Add Studio actions:

```ts
| { type: 'hydrateProject'; project: StudioProject }
| { type: 'hydrateSegments'; segments: Segment[] }
| { type: 'replaceSegment'; segment: Segment }
```

Add optional topbar status props:

```ts
cloudProgress?: number;
cloudDetail?: string;
```

`UploadPanel` callback:

```ts
onProcessStarted?: (value: { project: CloudProject; job: StartProcessingResult }) => void;
```

- [ ] **Step 1: Write RED Studio state tests**

Add a test proving `hydrateProject` replaces cloud content while preserving the selected segment when the same ID exists; otherwise select the first new segment.

Example assertion:

```ts
const next = studioReducer(state, { type: 'hydrateProject', project: cloudProject });
expect(next.project.id).toBe('cloud-p1');
expect(next.selectedSegmentId).toBe('s2');
```

- [ ] **Step 2: Run focused state test and verify RED**

```bash
npm test -- src/app/studioState.test.ts
```

Expected: FAIL because `hydrateProject` is not handled on Studio Pro V2.1 main.

- [ ] **Step 3: Implement minimal hydration actions in the current Studio Pro reducer**

Merge the proven reducer behavior from pipeline head into the current V2 reducer; retain all existing V2 actions and undo-related state.

- [ ] **Step 4: Write RED StudioShell orchestration test**

Render `StudioShell` with a cloud-start callback seam and assert the current shell still contains Studio Pro semantic regions while the upload callback can transition topbar cloud state to processing.

The test must assert at least:

```ts
expect(html).toContain('Nguồn media và nhân vật');
expect(html).toContain('Không gian chỉnh sửa');
expect(html).toContain('Processing');
```

and must not remove the mobile panel controls covered by existing tests.

- [ ] **Step 5: Verify StudioShell test RED**

```bash
npm test -- src/app/StudioShell.test.tsx
```

Expected: FAIL because StudioShell currently renders `<UploadPanel />` without live orchestration.

- [ ] **Step 6: Reconcile UploadPanel using the proven cloud flow**

Keep current panel markup/classes; replace its post-file workflow with `runCloudUpload(file)` and invoke `onProcessStarted({ project, job })` only after multipart completion and process start succeed.

Visible upload errors remain local and do not invoke `onProcessStarted`.

- [ ] **Step 7: Add cloud job orchestration to StudioShell, not App**

Inside `StudioShell` add state for:

```ts
const [activeJob, setActiveJob] = useState<{ projectId: string; jobId: string } | null>(null);
const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
const [cloudError, setCloudError] = useState('');
```

On process start, seed the queued job and call `followCloudJob(...)` in an effect with `AbortController`. On terminal success, dispatch `hydrateProject`; on failure, show the persisted error and stop polling.

- [ ] **Step 8: Extend StudioTopbar with truthful cloud progress**

Keep `StatusBadge`; when `cloudState === 'processing'`, derive detail from `cloudDetail ?? 'Cloud job active'` and optionally append a bounded integer percentage from `cloudProgress`.

Do not change existing save-state, history, command, mobile, export, or accessibility controls.

- [ ] **Step 9: Run shell/topbar/upload/state tests GREEN**

```bash
npm test -- src/app/studioState.test.ts src/app/StudioShell.test.tsx src/app/StudioTopbar.test.tsx src/features/upload
npm run typecheck
```

Expected: PASS, including pre-existing Studio Pro mobile/accessibility tests.

- [ ] **Step 10: Commit orchestration reconciliation**

```bash
git add src/app/studioState* src/app/StudioShell* src/app/StudioTopbar* src/features/upload
git commit -m "feat: connect Studio Pro shell to live dubbing jobs"
```

### Task 4: Reconcile ScriptInspector with Server-Backed Editing and Retranslation

**Files:**
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/features/transcript/ScriptInspector.test.tsx`
- Modify: `src/app/StudioShell.tsx`
- Test: `src/features/transcript/editorPersistence.test.ts`

**Interfaces:**

`ScriptInspector` receives optional live props:

```ts
cloudEditable?: boolean;
translationMode?: TranslationMode;
onTranslationModeChange?: (mode: TranslationMode) => void;
onCommitPatch?: (segmentId: string, patch: SegmentPatch) => void;
onRetranslate?: (segmentId: string) => void;
comparison?: { workersAI: string; google: string } | null;
onApplyTranslation?: (text: string) => void;
busy?: boolean;
error?: string;
```

- [ ] **Step 1: Add RED inspector regression tests**

Keep every existing Studio Pro inspector contract and add a cloud-mode render assertion for:

```text
Workers AI
Google
So sánh
Dịch lại
Áp dụng
```

Also assert demo mode omits live provider controls so it cannot emit cloud writes.

- [ ] **Step 2: Verify inspector tests RED**

```bash
npm test -- src/features/transcript/ScriptInspector.test.tsx
```

Expected: FAIL because current V2 inspector has no provider selector/retranslation controls.

- [ ] **Step 3: Merge live editor controls into current Studio Pro inspector**

Preserve current V2 structure/classes/tabs/accessibility. Add only live controls and callbacks. Text changes remain optimistic; blur invokes `onCommitPatch`. Speaker assignment invokes the same persistence callback.

Keep voice preview/regenerate/export controls guarded exactly as current product capability requires.

- [ ] **Step 4: Add editor state/callbacks to StudioShell**

Add:

```ts
const [translationMode, setTranslationMode] = useState<TranslationMode>('workers-ai');
const [translationComparison, setTranslationComparison] = useState<{ workersAI: string; google: string } | null>(null);
const [editorBusy, setEditorBusy] = useState(false);
const [editorError, setEditorError] = useState('');
```

Use `persistEditorPatch` for blur/speaker/apply and `retranslateEditorSegment` for provider actions. For single-provider results dispatch the returned server translation. For compare results set two choices and do not persist until `onApplyTranslation`.

- [ ] **Step 5: Preserve stale data on failures**

On patch/retranslate error, set `editorError` and do not replace the previous persisted translation. Google missing-secret errors must remain visible in the inspector.

- [ ] **Step 6: Run editor and shell suites GREEN**

```bash
npm test -- src/features/transcript/ScriptInspector.test.tsx src/features/transcript/editorPersistence.test.ts src/app/StudioShell.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit editor reconciliation**

```bash
git add src/features/transcript src/app/StudioShell.tsx
git commit -m "feat: persist Studio Pro transcript edits and retranslation"
```

### Task 5: Full Verification, Documentation, PR, Merge, and Runtime Qualification Boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment-status.md`
- Keep: `.github/workflows/ci.yml` unless verification no longer covers the runtime
- Keep: `.github/workflows/deploy-cloudflare.yml` current main semantics

**Interfaces:**
- Source-complete means exact-head CI/build/dry-run GREEN.
- Production-qualified means a real deployed small media fixture reaches persisted translated segments visible in the UI.

- [ ] **Step 1: Run full source verification**

```bash
npm install --no-audit --no-fund
npm run verify
npx wrangler deploy --dry-run
```

Expected: all commands exit `0`; no test failures, TypeScript errors, Vite build errors, or Wrangler binding/container errors.

- [ ] **Step 2: Update documentation truthfully**

README/deployment status must state:

```text
Implemented in source: R2 multipart -> Cloudflare Workflow -> FFmpeg 5-minute chunks -> Whisper ASR -> D1 segments -> Workers AI translation -> Studio Pro hydration/edit/retranslation.

Still capability-gated: TTS/voice cloning, visual lip-sync rendering, final dubbed export.

Production runtime qualification requires a real Cloudflare media fixture; source CI alone is not runtime PASS.
```

Preserve current account/domain/deployment trigger documentation from main.

- [ ] **Step 3: Re-check latest main before PR**

Compare `main` with branch head.

Expected: if `main` moved, reconcile the new main before opening/merging; do not merge a stale conflict-bearing branch.

- [ ] **Step 4: Open PR to current main and wait for exact-head CI**

PR body includes:

```text
Pipeline provenance: prior exact GREEN head 72bd05b3...
Reconciliation base: Studio Pro V2.1 main 665a6369...
Required gate: npm run verify + Wrangler dry-run + Studio Pro shell/mobile/accessibility regression suites.
Production runtime PASS is not claimed by this PR.
```

- [ ] **Step 5: Verify exact-head GitHub Actions GREEN**

Inspect the PR head workflow run and verify every step is `success`, especially `Verify source and production build` and `Wrangler dry-run`.

- [ ] **Step 6: Use finishing-a-development-branch before merge**

Invoke `superpowers:finishing-a-development-branch`, re-read current PR/head/main, then merge only with `expected_head_sha` equal to the exact GREEN head.

- [ ] **Step 7: Verify post-merge main CI and deployment outcome**

Check main CI on the merge SHA. If the current deployment workflow auto-runs, inspect it separately. A deployment failure is not to be hidden as source success.

- [ ] **Step 8: Run or report runtime qualification boundary**

If production deploy succeeds and tooling allows a real fixture run, qualify:

```text
small supported media -> upload -> process -> terminal job -> persisted segments -> translated UI
```

If fixture execution is unavailable, report production runtime as UNQUALIFIED rather than PASS.

## Completion Gate

Before claiming reconciliation complete, verify all of these with fresh evidence:

- backend Container/Workflow/job/ASR/translation tests GREEN
- Studio Pro shell/mobile/accessibility tests GREEN
- upload -> process -> poll -> hydrate orchestration tests GREEN
- editor persistence/retranslation/compare tests GREEN
- `npm run verify` GREEN
- Wrangler dry-run GREEN
- exact-head PR Actions GREEN
- latest main re-checked immediately before merge
- post-merge main CI GREEN
- production runtime status reported separately and truthfully
