# DubFlow Live Pipeline + UI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current YupVox UI and source-level provider adapters into one real asynchronous Cloudflare flow: video upload -> FFmpeg audio chunks -> Workers AI ASR -> persisted D1 segments -> Workers AI/Google translation -> live transcript/timeline hydration and editing.

**Architecture:** Keep the browser thin and project-scoped. Cloudflare Workflows owns long-running orchestration; a Cloudflare Container runs FFmpeg and streams media through R2; Workers AI transcribes bounded audio chunks; D1 stores project/job/segment truth. The React editor polls one project processing status endpoint and replaces mock segments only after persisted cloud data exists. TTS/export remain capability-gated and are not part of this slice.

**Tech Stack:** React 19, TypeScript, Hono, Cloudflare Workers Static Assets, D1, R2, Workers AI `@cf/openai/whisper-large-v3-turbo`, Cloudflare Workflows, Cloudflare Containers, FFmpeg, Vitest, Wrangler, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-05-dubflow-design.md`

## Global Constraints

- Maximum source media remains 5 GB and 3 hours.
- Never buffer the complete uploaded video or complete extracted audio in Worker memory.
- FFmpeg must produce independent bounded audio chunks; the Worker may buffer only one chunk at a time for Workers AI.
- Source languages remain `auto`, `zh`, `en`, `ja`, `ko`; target remains `vi`.
- ASR always uses `task: "transcribe"`; model output never owns segment IDs or global timestamps.
- Persisted D1 data is the UI source of truth after cloud processing starts.
- GitHub Actions CI stays enabled and must run `npm run verify` plus `wrangler deploy --dry-run`.
- Cloudflare production deployment stays `workflow_dispatch` only until `CLOUDFLARE_API_TOKEN` exists.
- Do not claim TTS, voice cloning, lip-sync rendering, or final export success in this slice.

---

### Task 1: Add the FFmpeg Container Contract

**Files:**
- Modify: `package.json`
- Modify: `wrangler.jsonc`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/services/media/types.ts`
- Create: `worker/src/containers/FfmpegContainer.ts`
- Create: `worker/src/services/media/container.ts`
- Create: `containers/ffmpeg/Dockerfile`
- Create: `containers/ffmpeg/server.mjs`
- Test: `worker/test/media-container.test.ts`
- Test: `tests/deploy-config.test.mjs`

**Interfaces:**
- `MediaProcessor.probe(objectKey: string): Promise<{ durationMs: number }>`
- `MediaProcessor.extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]>`
- `type AudioChunk = { objectKey: string; offsetMs: number; durationMs: number }`
- `ContainerMediaProcessor` communicates with a project-named `FFMPEG_CONTAINER` Durable Object/container instance.
- `FfmpegContainer` uses `defaultPort = 8080` and exposes R2 to the container through an outbound virtual host `media.r2`.

- [ ] **Step 1: Write RED contract tests**

```ts
it('requests bounded 5-minute audio chunks from the project container', async () => {
  const calls: Request[] = [];
  const processor = new ContainerMediaProcessor(
    { getByName: () => ({ fetch: async (request: Request) => {
      calls.push(request);
      return Response.json({ chunks: [{ objectKey: 'projects/p/audio/000.wav', offsetMs: 0, durationMs: 300000 }] });
    } }) },
  );
  await expect(processor.extractAudioChunks('p', 'projects/p/source/a.mp4')).resolves.toHaveLength(1);
  expect(await calls[0].json()).toMatchObject({ projectId: 'p', objectKey: 'projects/p/source/a.mp4', chunkSeconds: 300 });
});
```

Add deploy-config assertions for `containers[0].class_name === 'FfmpegContainer'`, `durable_objects.bindings` binding name `FFMPEG_CONTAINER`, and an exported SQLite Durable Object class.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- worker/test/media-container.test.ts
npm run verify:deploy-config
```

Expected: FAIL because the container binding/configuration and processor do not exist.

- [ ] **Step 3: Add the container dependency and Wrangler bindings**

Add `@cloudflare/containers` to dependencies. Configure:

```json
"containers": [{
  "class_name": "FfmpegContainer",
  "image": "./containers/ffmpeg/Dockerfile",
  "max_instances": 4,
  "instance_type": "basic"
}],
"durable_objects": {
  "bindings": [{ "name": "FFMPEG_CONTAINER", "class_name": "FfmpegContainer" }]
},
"exports": {
  "FfmpegContainer": { "type": "durable-object", "state": "created", "storage": "sqlite" }
}
```

- [ ] **Step 4: Implement the container Durable Object and R2 outbound bridge**

`FfmpegContainer` extends `Container`, sets port `8080`, and defines an outbound handler for `media.r2`. `GET` returns `env.MEDIA.get(key).body`; `PUT` writes the request body to `env.MEDIA.put(key, request.body)`; other methods return `405`.

- [ ] **Step 5: Implement the FFmpeg HTTP service**

`containers/ffmpeg/server.mjs` exposes:

```text
POST /probe
POST /extract-audio-chunks
GET /health
```

`/probe` downloads the source through `http://media.r2/<encoded-key>`, runs `ffprobe`, and returns integer `durationMs`.

`/extract-audio-chunks` downloads one source file to container disk, then runs FFmpeg with mono 16 kHz PCM WAV and the segment muxer at `300` seconds. Each output is uploaded to `projects/{projectId}/audio/{index}.wav` using `PUT http://media.r2/...`; response entries include exact `offsetMs = index * 300000` and duration from `ffprobe` for each chunk. Temp files are removed in `finally`.

- [ ] **Step 6: Implement `ContainerMediaProcessor`**

Use `env.FFMPEG_CONTAINER.getByName(projectId)` and JSON requests to the container. Reject non-2xx responses with `MEDIA_PROCESSOR_FAILED` and validate every returned chunk has `durationMs > 0`, `offsetMs >= 0`, and a project-confined object key.

- [ ] **Step 7: Run focused tests, typecheck, and Wrangler dry-run**

```bash
npm test -- worker/test/media-container.test.ts
npm run typecheck
npx wrangler deploy --dry-run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json wrangler.jsonc worker/src containers/ffmpeg tests/deploy-config.test.mjs worker/test/media-container.test.ts
git commit -m "feat: add FFmpeg Cloudflare container bridge"
```

### Task 2: Add Durable Dubbing Job Persistence

**Files:**
- Create: `worker/src/db/jobs.ts`
- Modify: `worker/src/db/projects.ts`
- Create: `worker/src/routes/jobs.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/jobs.test.ts`

**Interfaces:**

```ts
export type DubbingJob = {
  id: string;
  projectId: string;
  status: 'queued'|'running'|'needs_review'|'failed'|'completed'|'cancelled';
  progress: number;
  currentStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};
```

`JobStore.create(projectId, 'dubbing')`, `getForProject(projectId, jobId, userId)`, `setProgress(...)`, `fail(...)`, and `complete(...)` are the only mutation surface.

- [ ] **Step 1: Write RED tests** proving authorization, monotonic progress in `[0,1]`, and persisted error codes/messages.
- [ ] **Step 2: Run `npm test -- worker/test/jobs.test.ts` and confirm RED.**
- [ ] **Step 3: Implement `JobRepository` using the existing `jobs` table** and project ownership joins.
- [ ] **Step 4: Add `GET /api/projects/:id/jobs/:jobId`** returning the project-scoped job; unknown/foreign jobs return `404`.
- [ ] **Step 5: Add `ProjectStore.setStatus(id,userId,status,durationMs?)`** so workflow steps can move `ready -> processing -> needs_review` or `failed`.
- [ ] **Step 6: Run focused tests + typecheck GREEN.**
- [ ] **Step 7: Commit `feat: persist dubbing job status`.**

### Task 3: Persist ASR Output Deterministically

**Files:**
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/domain/segment.ts`
- Test: `worker/test/asr-persistence.test.ts`

**Interfaces:**

```ts
export type PersistedAsrSegment = {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
};

SegmentStore.replaceFromAsr(projectId, userId, segments): Promise<Segment[]>;
```

- [ ] **Step 1: Write RED tests** for deterministic replacement order, exact IDs/timestamps, deletion of stale prior ASR segments, and rejection of duplicate IDs or inverted ranges.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement one D1 transaction-equivalent batch**: authorize project, delete current project segments, insert validated rows with `translated_text=''`, `translation_status='pending'`, `voice_status='pending'`, then list ordered rows.
- [ ] **Step 4: Run focused tests + typecheck GREEN.**
- [ ] **Step 5: Commit `feat: persist normalized ASR segments`.**

### Task 4: Implement the Cloudflare Workflow Orchestrator

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `worker/src/env.ts`
- Create: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/dubbing-workflow.test.ts`
- Test: `worker/test/process-route.test.ts`
- Modify: `tests/deploy-config.test.mjs`

**Interfaces:**
- Wrangler binding: `DUBBING_WORKFLOW` -> class `DubbingWorkflow`, name `dubflow-dubbing`.
- Workflow params: `{ projectId: string; userId: string; jobId: string }`.
- `POST /api/projects/:id/process` creates a persisted job and workflow instance, then returns `202 { jobId, workflowId, status:'queued' }`.

Workflow step sequence:

```text
1. authorize + mark project/job running
2. ffprobe source and enforce <= 3 hours
3. FFmpeg extract 5-minute WAV chunks to R2
4. for each chunk: R2 get only that chunk -> Workers AI ASR -> normalize with chunk offset
5. replace persisted source segments
6. translate each persisted segment with Workers AI by default
7. mark project needs_review + job complete
```

- [ ] **Step 1: Write RED tests** with injected fakes for media, R2, ASR, translation, segments, jobs, and project store. Assert step order, one-chunk-at-a-time reads, and failure persistence.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Configure the Workflow binding** in `wrangler.jsonc` and extend `Env` with a small portable `WorkflowBindingLike` used by route tests.
- [ ] **Step 4: Implement `DubbingWorkflow`** using Cloudflare `WorkflowEntrypoint`; each expensive boundary is a named `step.do()` so retries are durable. Use `WorkersAIAsrProvider` and `normalizeAsrChunks`; model results never provide global IDs.
- [ ] **Step 5: Translate persisted segments** with `WorkersAITranslationProvider` in bounded batches/iterations, then persist each accepted result via `setTranslationResult`.
- [ ] **Step 6: Rewrite `POST /:id/process`** to start the Workflow instead of returning `MEDIA_PROCESSOR_UNAVAILABLE`.
- [ ] **Step 7: Persist failures** as job `failed`, project `failed`, and a stable code (`MEDIA_PROCESSOR_FAILED`, `ASR_FAILED`, `TRANSLATION_FAILED`, or `PIPELINE_FAILED`).
- [ ] **Step 8: Run focused tests, full typecheck, and Wrangler dry-run GREEN.**
- [ ] **Step 9: Commit `feat: orchestrate dubbing with Cloudflare Workflows`.**

### Task 5: Add Frontend Cloud Project/Job/Segment API Types

**Files:**
- Modify: `src/features/projects/projectApi.ts`
- Create: `src/features/projects/jobApi.ts`
- Create: `src/features/transcript/segmentApi.ts`
- Modify: `src/features/translation/translationApi.ts`
- Test: `src/features/projects/jobApi.test.ts`
- Test: `src/features/transcript/segmentApi.test.ts`

**Interfaces:**

```ts
startProcessing(projectId): Promise<{ jobId: string; workflowId: string; status: 'queued' }>;
getJob(projectId, jobId): Promise<CloudJob>;
listSegments(projectId): Promise<CloudSegment[]>;
patchSegment(projectId, segmentId, patch): Promise<CloudSegment>;
```

`CloudSegment` mirrors the backend persistence shape including `version`, `translationEngine`, `translationStatus`, and nullable `speakerId`.

- [ ] **Step 1: Write RED API tests** for URLs, JSON payloads, error decoding, and response typing.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement the API modules with `apiFetch`.**
- [ ] **Step 4: Make `retranslateSegment()` return a typed union for single-provider and compare responses.**
- [ ] **Step 5: Run focused tests + typecheck GREEN.**
- [ ] **Step 6: Commit `feat: add live dubbing frontend APIs`.**

### Task 6: Replace Mock-Only Studio State with Cloud Hydration

**Files:**
- Modify: `src/app/studioState.ts`
- Modify: `src/app/useStudioState.ts`
- Create: `src/app/cloudProjectAdapter.ts`
- Test: `src/app/studioState.test.ts`
- Test: `src/app/cloudProjectAdapter.test.ts`

**Interfaces:**

```ts
StudioAction +=
  | { type: 'hydrateProject'; project: StudioProject }
  | { type: 'hydrateSegments'; segments: Segment[] }
  | { type: 'replaceSegment'; segment: Segment };

cloudToStudioProject(project: CloudProject, segments: CloudSegment[]): StudioProject;
```

When cloud segments have `speakerId === null`, map them to one UI-only `unassigned` speaker row until real diarization exists. Do not invent distinct characters from ASR text.

- [ ] **Step 1: Write RED reducer/adapter tests** for replacing mock segments with persisted rows while preserving current selection where possible.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement hydration actions and adapter.**
- [ ] **Step 4: Run tests GREEN.**
- [ ] **Step 5: Commit `refactor: hydrate studio from cloud project data`.**

### Task 7: Wire Upload -> Process -> Poll -> Hydrate

**Files:**
- Modify: `src/features/upload/UploadPanel.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/features/projects/projectApi.ts`
- Modify: `src/app/app.css`
- Test: `src/app/App.test.tsx`
- Create: `src/features/projects/useDubbingJob.ts`
- Test: `src/features/projects/useDubbingJob.test.tsx`

**Interfaces:**
- `UploadPanel` receives `onProjectReady(project: CloudProject, jobId: string): void`.
- `useDubbingJob(projectId, jobId)` polls no faster than every 2 seconds and stops on `completed`, `failed`, or unmount.
- On `completed`, App calls `listSegments(projectId)` and dispatches `hydrateProject`.

- [ ] **Step 1: Write RED integration tests** proving upload completion starts processing, visible states change `uploading -> processing -> transcript ready`, and failed jobs show the server error without fake success.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Update UploadPanel** so successful multipart completion immediately calls `startProcessing(project.id)`. Status copy becomes `Đang tách âm thanh`, `Đang nhận dạng giọng nói`, `Đang dịch`, or `Sẵn sàng rà soát` using job `currentStep`.
- [ ] **Step 4: Implement polling hook** with cleanup via `AbortController`/timer cancellation.
- [ ] **Step 5: Hydrate the center player/timeline/inspector** from D1 segments once the job completes; keep the local selected file only as the preview video source.
- [ ] **Step 6: Run UI tests + typecheck GREEN.**
- [ ] **Step 7: Commit `feat: connect upload to live dubbing pipeline`.**

### Task 8: Persist Editor Changes and Real Retranslation

**Files:**
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/studioState.ts`
- Test: `src/features/transcript/ScriptInspector.test.tsx`

**Interfaces:**
- Text changes remain optimistic locally but persist on blur through `PATCH /segments/:segmentId`.
- Retranslate uses selected mode `workers-ai | google | compare`.
- Single-provider results replace the selected persisted segment with the server response.
- Compare mode shows both alternatives and never overwrites D1 until the user explicitly chooses one.

- [ ] **Step 1: Write RED tests** for optimistic edit + persisted blur, retranslation loading/error state, Google missing-secret error visibility, and compare-mode no-overwrite behavior.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Add translation mode selector and `Dịch lại` button** matching the existing inspector visual language.
- [ ] **Step 4: Persist source/translated text and speaker assignment on blur**; if the API rejects the patch, show an error and re-fetch the segment.
- [ ] **Step 5: Wire real retranslation response** into `replaceSegment`; compare results render as two selectable cards.
- [ ] **Step 6: Keep voice preview/regenerate/export disabled** with explicit capability messaging.
- [ ] **Step 7: Run focused UI tests + full typecheck GREEN.**
- [ ] **Step 8: Commit `feat: persist transcript edits and retranslation`.**

### Task 9: Full CI Verification and Live-Qualification Guardrails

**Files:**
- Modify: `.github/workflows/ci.yml` only if the existing `npm run verify` + Wrangler dry-run no longer exercises the container/workflow config.
- Modify: `README.md`
- Modify: `docs/deployment-status.md`
- Test: existing deploy-config/workflow tests plus all Vitest suites.

- [ ] **Step 1: Run the full verification gate**

```bash
npm install --no-audit --no-fund
npm run verify
npx wrangler deploy --dry-run
```

Expected: all PASS.

- [ ] **Step 2: Confirm GitHub Actions exact-head GREEN** for branch `feat/live-pipeline-ui` with test/build/dry-run all successful.
- [ ] **Step 3: Update documentation** to state that source-level upload -> workflow -> FFmpeg chunks -> ASR -> translation -> D1 -> UI is implemented, while production qualification still requires a manually triggered deploy with `CLOUDFLARE_API_TOKEN`.
- [ ] **Step 4: Do not mark production runtime PASS** until a real Cloudflare run uploads a small fixture and returns persisted translated segments through the UI.
- [ ] **Step 5: Commit `docs: document live dubbing pipeline qualification`.**

## Completion Gate

This slice is source-complete only when all of the following are true:

- GitHub Actions exact-head CI is GREEN.
- `npm run verify` and `wrangler deploy --dry-run` are GREEN.
- No Worker path buffers the full video/full extracted audio.
- FFmpeg container emits bounded standalone audio chunks and cleans temp files.
- Workflow persists durable job progress and deterministic ASR segments.
- Workers AI translation is persisted before the job becomes `completed`.
- UI replaces mock transcript/timeline data with D1 data after job completion.
- Transcript edits and retranslation are server-backed and errors remain visible.
- TTS, voice cloning, lip-sync rendering, and export remain explicitly unavailable unless separately qualified.

## Next Plan After This Gate

Only after this pipeline slice is GREEN: run the dedicated visual pass against the supplied 1448×1086 reference, adjust spacing/typography/timeline density, and verify the final screenshot at the target viewport without changing the now-live data flow.
