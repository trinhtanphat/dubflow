# DubFlow Phase 4D Dialogue / Background Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in dialogue/background stem separation so dubbed exports can preserve music/ambience while keeping the existing source-mix export unchanged.

**Architecture:** Keep provider admission in the Worker/Workflow, heavy media transfer and ZIP normalization in the existing Cloudflare FFmpeg Container, and secrets in the Worker runtime. The first provider uses ElevenLabs Stem Separation `two_stems_v1`; `FfmpegContainer.outboundByHost` injects `xi-api-key` for `api.elevenlabs.io`, while the container normalizes provider stem files to immutable project-scoped R2 keys. Export orchestration consumes a `StemSeparationProvider` and passes an optional validated background stem into the existing render path.

**Tech Stack:** TypeScript, Hono, Cloudflare Workflows/Containers/R2/D1, Vitest, Node test runner, FFmpeg, ElevenLabs Stem Separation API.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4d-dialogue-background-separation-design.md`

## Global Constraints

- `source_mix` must remain the default and must not invoke stem separation.
- `preserve_background` must fail closed when separation is unavailable; never silently downgrade.
- Worker code must not buffer multi-GB source media or shell out to FFmpeg.
- Provider secrets remain in Worker bindings; never persist them or pass them into the container filesystem.
- Stem keys are immutable and project-scoped: `projects/{projectId}/stems/{sourceRevision}/dialogue.wav` and `background.wav`.
- Retry accounting must use the existing started/completed operation-key pattern and must not double-complete usage.
- Production Workers Builds must retain `containers` and `durable_objects`; `FFMPEG_CONTAINER` is mandatory for the media path.
- Runtime remains UNQUALIFIED until a live supported fixture proves separation and final export.

---

### Task 1: Separation domain and capability contracts

**Files:**
- Create: `worker/src/services/separation/types.ts`
- Create: `worker/src/services/separation/container.ts`
- Test: `worker/src/services/separation/container.test.ts`

**Interfaces:**
- Produces `SeparationMode = 'source_mix' | 'preserve_background'`.
- Produces `StemSeparationProvider` with `id`, `available`, and `separate(input)`.
- Produces `ContainerStemSeparationProvider` backed by `MediaProcessor.separateStems`.

- [ ] **Step 1: Write failing provider-contract tests**

```ts
it('reports unavailable when the required container/provider capability is missing', () => {
  const provider = new ContainerStemSeparationProvider(undefined, false);
  expect(provider.available).toBe(false);
});

it('delegates an exact project/source revision to media separation', async () => {
  const media = { separateStems: vi.fn().mockResolvedValue({
    dialogueObjectKey: 'projects/p1/stems/r1/dialogue.wav',
    backgroundObjectKey: 'projects/p1/stems/r1/background.wav',
  }) };
  const provider = new ContainerStemSeparationProvider(media, true);
  await provider.separate({ projectId: 'p1', sourceObjectKey: 'projects/p1/source/a.mp4', sourceRevision: 'r1' });
  expect(media.separateStems).toHaveBeenCalledWith('p1', 'projects/p1/source/a.mp4', 'r1');
});
```

- [ ] **Step 2: Run `npm run test -- worker/src/services/separation/container.test.ts` and confirm RED**
- [ ] **Step 3: Implement the minimal domain/provider classes**
- [ ] **Step 4: Re-run the focused test and confirm GREEN**
- [ ] **Step 5: Commit `feat(separation): add provider boundary`**

### Task 2: Media/container separation endpoint and strict object-key validation

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/server.mjs`
- Create: `containers/ffmpeg/stem-separation.mjs`
- Modify: `containers/ffmpeg/Dockerfile`
- Test: `worker/src/services/media/container.test.ts`
- Test: `containers/ffmpeg/stem-separation.test.mjs`

**Interfaces:**
- `MediaProcessor.separateStems(projectId, sourceObjectKey, sourceRevision): Promise<StemSeparationResult>`.
- Container endpoint `POST /separate-stems` receives `{ projectId, objectKey, sourceRevision }`.
- Container returns only canonical R2 keys, never provider temporary paths.

- [ ] **Step 1: Add failing tests for malformed revision/key, response-key mismatch, and two-stem filename normalization**

```ts
await expect(processor.separateStems('p1', 'projects/p2/source/a.mp4', 'r1'))
  .rejects.toMatchObject({ code: 'MEDIA_OBJECT_KEY_INVALID' });
```

```js
assert.deepEqual(classifyTwoStemFiles(['vocals.wav', 'instrumental.wav']), {
  dialogue: 'vocals.wav', background: 'instrumental.wav'
});
```

- [ ] **Step 2: Run focused Vitest + Node tests and confirm RED**
- [ ] **Step 3: Add `separateStems` to media types and ContainerMediaProcessor; validate `sourceRevision` with `/^[A-Za-z0-9._-]{1,200}$/` and exact project prefixes**
- [ ] **Step 4: Implement container helper: download source through `media.r2`, submit multipart audio to ElevenLabs with `stem_variation_id=two_stems_v1`, save ZIP, extract with `unzip`, classify vocal/instrumental entries, upload normalized WAV stems back through `media.r2`**
- [ ] **Step 5: Add `unzip` to the FFmpeg image and copy the helper into the image**
- [ ] **Step 6: Re-run focused tests and confirm GREEN**
- [ ] **Step 7: Commit `feat(media): add container stem separation`**

### Task 3: Secure ElevenLabs container egress

**Files:**
- Modify: `worker/src/containers/FfmpegContainer.ts`
- Modify: `worker/src/env.ts`
- Test: `worker/src/containers/FfmpegContainer.test.ts`
- Modify: `tests/phase4d-separation-acceptance.test.mjs`

**Interfaces:**
- Existing `ELEVENLABS_API_KEY` remains the only credential source.
- `FfmpegContainer.allowedHosts` includes `media.r2` and `api.elevenlabs.io`.
- HTTPS interception injects `xi-api-key` only for the exact ElevenLabs host.

- [ ] **Step 1: Write failing tests that assert no key is stored in container config and that the outbound handler adds `xi-api-key` only for `api.elevenlabs.io`**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Set `interceptHttps = true`, allow `api.elevenlabs.io`, and add the outbound handler which clones the request, attaches `env.ELEVENLABS_API_KEY`, and forwards it**
- [ ] **Step 4: Keep `media.r2` binding proxy behavior unchanged**
- [ ] **Step 5: Re-run tests and confirm GREEN**
- [ ] **Step 6: Commit `feat(separation): secure provider egress`**

### Task 4: Export request admission and capability API

**Files:**
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `src/features/export/batchExportApi.ts`
- Test: `worker/src/routes/export.test.ts`
- Test: `src/features/export/batchExportApi.test.ts`

**Interfaces:**
- Export request gains `separationMode?: SeparationMode`, defaulting to `source_mix`.
- Workflow params carry the exact normalized mode.
- Add `GET /api/projects/:id/export-capabilities` returning separation availability/modes.

- [ ] **Step 1: Write failing route/API tests for default `source_mix`, explicit `preserve_background`, invalid mode, and unavailable capability -> `503 STEM_SEPARATION_UNAVAILABLE` before job creation**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Parse/normalize the mode in single and batch export routes; pass it into workflow params**
- [ ] **Step 4: Build capability from `Boolean(env.FFMPEG_CONTAINER && env.ELEVENLABS_API_KEY?.trim())` without exposing secret values**
- [ ] **Step 5: Re-run focused tests and confirm GREEN**
- [ ] **Step 6: Commit `feat(export): admit background-preserving exports`**

### Task 5: Idempotent separation orchestration and usage accounting

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/src/domain/usage.ts` if the usage-kind union is defined there
- Test: `worker/src/workflows/exportPipeline.test.ts`
- Modify: `tests/phase3b-usage-acceptance.test.mjs`

**Interfaces:**
- Usage kind: `stem_separation_audio_second`.
- Operation key includes export job retry generation, source revision, and provider id.
- Existing canonical stem pair is reused before provider invocation.

- [ ] **Step 1: Write failing tests proving `source_mix` never invokes provider; `preserve_background` invokes once; durable completed stems are reused; started-with-artifact recovers completion; completed-without-artifact fails**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Derive deterministic `sourceRevision` from the immutable source object key; do not use timestamps**
- [ ] **Step 4: Record started usage before provider call and completed usage after canonical stems are durable; meter source duration seconds from `media.probe`**
- [ ] **Step 5: Pass `backgroundObjectKey` into render options only for `preserve_background`**
- [ ] **Step 6: Re-run focused and Phase 3B accounting tests and confirm GREEN**
- [ ] **Step 7: Commit `feat(export): orchestrate idempotent stem separation`**

### Task 6: Render against background stem

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/server.mjs`
- Test: `containers/ffmpeg/render-export.test.mjs`
- Test: `tests/render-export-duration.test.mjs`

**Interfaces:**
- `RenderExportOptions.backgroundObjectKey?: string`.
- Container render body accepts optional project-scoped background stem.

- [ ] **Step 1: Add failing tests that the background key must match `projects/{projectId}/stems/.../background.wav` and that the render graph uses it as the audio bed while preserving original video**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Download the background stem when present; feed it into the existing duration-fit/mix graph instead of source audio; keep the no-background graph byte-for-byte compatible in semantics**
- [ ] **Step 4: Re-run render tests and confirm GREEN**
- [ ] **Step 5: Commit `feat(media): render dubbed clips over preserved background`**

### Task 7: Studio controls, acceptance gates, and production qualification

**Files:**
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batchExportApi.ts`
- Modify: `src/features/export/batch-export.css`
- Create: `tests/phase4d-separation-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- UI choice `Source mix` / `Preserve background/music` appears for dubbed output.
- Preserve-background control is disabled with an explanatory reason when capability is absent.

- [ ] **Step 1: Write failing UI and source-acceptance tests for fail-closed capability, request payload propagation, production container binding retention, and unchanged source-mix default**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Implement the UI controls and wire capability loading/request payloads**
- [ ] **Step 4: Add Phase 4D acceptance test to `verify:deploy-config` and document source/runtime qualification separately**
- [ ] **Step 5: Run `npm run verify`**
- [ ] **Step 6: Run `npx wrangler deploy --dry-run`**
- [ ] **Step 7: Push exact head and require GitHub CI FULL GREEN before merge**
- [ ] **Step 8: After merge, require Workers Builds success and live `/api/ready` plus a supported real separation fixture before marking Phase 4D runtime PASS**
- [ ] **Step 9: Commit `feat: complete Phase 4D background-preserving export`**
