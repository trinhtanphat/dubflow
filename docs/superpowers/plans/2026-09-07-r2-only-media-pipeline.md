# R2-only Media Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Cloudflare Stream from DubFlow production and replace it with signed private-R2 source delivery plus Worker-side MP4 remux that preserves the encoded source video track and writes the dubbed result directly to R2.

**Architecture:** The active dubbing path exposes the exact private R2 source through a short-lived HMAC URL and sends that URL directly to remote ASR. The export path reads the source with ranged R2 access, copies encoded H.264/compatible video packets into a Mediabunny MP4 output, AAC-encodes only the generated PCM soundtrack, and streams the final file into an R2 multipart upload with bounded memory and backpressure. Stream-specific runtime code/config becomes inactive and then is removed without rewriting historical D1 migrations.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, R2, D1, Cloudflare Workflows, Deepgram remote ASR, Mediabunny, `@mediabunny/aac-encoder`, Vitest, Node test runner, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-07-r2-only-media-pipeline-design.md`

## Global Constraints

- Backend Worker/state/resources remain on account `trinhtanphat6666` (`6c5207813df3d5b83b9508125e0e9e12`).
- Gateway/domain remain on account `trinhtanphat2403` (`50afb4fd3c4c7a1f3e1bdb7f22d4af7f`).
- Production uses no Cloudflare Containers.
- Production uses no Cloudflare Stream binding, Stream API token, Stream ingest, Stream downloads, or Stream delivery.
- Source and final media are stored in private R2.
- Long-form ASR uses a signed R2-backed media URL and must fail closed without a remote-capable provider.
- Final dubbed MP4 must not re-encode the source video track.
- H.264/AVC MP4 is the required baseline standard-export input; unsupported video that needs transcoding fails with `VIDEO_TRANSCODE_REQUIRED`.
- Existing maximum media duration remains 3 hours.
- Multi-hour source/output files must never be buffered as one `ArrayBuffer`.
- Historical migrations must not be renamed, rewritten, replayed, or collapsed; already-shipped D1 filenames remain intact.
- Existing subtitle, translation, TTS, sharing, visual-lip-sync qualification, gateway topology, and D1 migration lineage must remain intact.
- No automatic fallback to Cloudflare Stream or Containers is permitted.

---

### Task 1: Replace Stream-specific source tokens and route with generic signed R2 media source

**Files:**
- Create: `worker/src/security/media-source-token.ts`
- Create: `worker/src/routes/media-source.ts`
- Modify: `worker/src/app.ts`
- Modify: `worker/src/env.ts`
- Test: `worker/test/media-source-token.test.ts`
- Test: `worker/test/media-source-route.test.ts`
- Remove after GREEN: `worker/src/security/stream-source-token.ts`
- Remove after GREEN: `worker/src/routes/stream-source.ts`

**Interfaces:**
- Produces: `createMediaSourceToken(secret, projectId, objectKey, expires): Promise<string>`.
- Produces: `verifyMediaSourceToken({ secret, projectId, objectKey, expires, signature, nowSeconds? }): Promise<boolean>`.
- Produces: `createMediaSourceRoutes()` mounted at `/api/media-source`.
- Canonical env key: `MEDIA_SOURCE_SIGNING_SECRET?: string`; temporary fallback alias: `STREAM_SOURCE_SIGNING_SECRET?: string`.

- [ ] **Step 1: Write failing token tests**

Create tests that prove token binding to the exact project/object/expiry and reject cross-project, expired, malformed, or mutated keys:

```ts
const signature = await createMediaSourceToken('secret', 'project-1', 'projects/project-1/source/movie.mp4', 2_000);
expect(await verifyMediaSourceToken({
  secret: 'secret',
  projectId: 'project-1',
  objectKey: 'projects/project-1/source/movie.mp4',
  expires: 2_000,
  signature,
  nowSeconds: 1_000,
})).toBe(true);
expect(await verifyMediaSourceToken({
  secret: 'secret',
  projectId: 'project-1',
  objectKey: 'projects/project-1/source/other.mp4',
  expires: 2_000,
  signature,
  nowSeconds: 1_000,
})).toBe(false);
```

- [ ] **Step 2: Run token tests and verify RED**

Run: `npx vitest run worker/test/media-source-token.test.ts`
Expected: FAIL because `media-source-token.ts` does not exist.

- [ ] **Step 3: Implement media-neutral HMAC token**

Use the current Stream token algorithm but change names/messages to media-neutral wording. Preserve the invariant `objectKey.startsWith(\`projects/${projectId}/\`)`, 64-hex SHA-256 HMAC signatures, and positive integer expiry.

- [ ] **Step 4: Write failing route tests for HEAD/full body/Range/current-source binding**

The route fixture must expose a project repository with `sourceObjectKey = 'projects/project-1/source/movie.mp4'` and an R2 object with deterministic bytes. Tests must assert:

```ts
expect((await app.request(url, { method: 'HEAD' }, env)).status).toBe(200);
expect((await app.request(url, { headers: { Range: 'bytes=2-5' } }, env)).status).toBe(206);
expect(await rangeResponse.arrayBuffer()).toEqual(Uint8Array.from([2, 3, 4, 5]).buffer);
```

Also assert 403 for a bad token, 404 for a missing object, and a fail-closed response when the signed object key no longer matches the project's current `sourceObjectKey`.

- [ ] **Step 5: Run route tests and verify RED**

Run: `npx vitest run worker/test/media-source-route.test.ts`
Expected: FAIL because `/api/media-source/:projectId` is not mounted.

- [ ] **Step 6: Implement route authorization and R2 range serving**

`createMediaSourceRoutes()` must verify HMAC using `MEDIA_SOURCE_SIGNING_SECRET ?? STREAM_SOURCE_SIGNING_SECRET ?? ''`, load the current project for the token-bound project id, compare exact `sourceObjectKey`, then delegate body/range delivery to `streamMediaObject`. `HEAD` must set `Accept-Ranges`, `Content-Length`, `Content-Type`, and `ETag` when available.

- [ ] **Step 7: Mount the new route and keep the old route absent from active app wiring**

Update `worker/src/app.ts` to mount:

```ts
app.route('/api/media-source', createMediaSourceRoutes());
```

Remove the active `/api/stream-source` mount. Add `MEDIA_SOURCE_SIGNING_SECRET?: string` to `Env`; keep `STREAM_SOURCE_SIGNING_SECRET?: string` only as a migration alias.

- [ ] **Step 8: Run focused tests GREEN and commit**

Run: `npx vitest run worker/test/media-source-token.test.ts worker/test/media-source-route.test.ts`
Expected: PASS.

Commit message: `feat(media): add signed R2 media source route`.

---

### Task 2: Make dubbing send the signed R2 source URL directly to remote ASR

**Files:**
- Create: `worker/src/services/media/r2-source.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/services/asr/types.ts`
- Modify: `worker/src/services/asr/deepgram.ts`
- Test: `worker/test/r2-source-service.test.ts`
- Test: `worker/test/deepgram-remote.test.ts`
- Test: `worker/test/zero-stream-dubbing-pipeline.test.ts`

**Interfaces:**
- Produces: `R2SourceMediaService.prepareSource(projectId, userId, sourceObjectKey): Promise<{ sourceId: string; audioUrl: string; durationMs: number | null }>` where `audioUrl` is the signed media-source URL and `sourceId` is the immutable source object key.
- Extend remote ASR result with optional `durationMs?: number` derived from provider metadata.
- `runDubbingPipeline` must accept nullable prepared-source duration and use remote ASR duration when the prepared source cannot know duration safely.

- [ ] **Step 1: Write RED service test proving no Stream call exists**

Construct `R2SourceMediaService` with project store, public origin, signing secret, and deterministic clock. Assert `prepareSource()` returns a URL under `/api/media-source/project-1`, contains the exact object key/expiry/signature, and does not require a Stream binding.

- [ ] **Step 2: Run service test RED**

Run: `npx vitest run worker/test/r2-source-service.test.ts`
Expected: FAIL because `R2SourceMediaService` does not exist.

- [ ] **Step 3: Implement `R2SourceMediaService`**

The service must authorize that the object key still equals the project's current source, create a 15-minute HMAC URL using `createMediaSourceToken`, and return `{ sourceId: sourceObjectKey, audioUrl, durationMs: project.durationMs ?? null }` only when an existing positive bounded duration is already known.

- [ ] **Step 4: Extend Deepgram result metadata test**

Add a Deepgram fixture with `metadata.duration: 12.5` and assert the provider returns `durationMs: 12_500` alongside segments. Invalid/zero duration must yield `durationMs: undefined` rather than trusting it.

- [ ] **Step 5: Run Deepgram RED then implement metadata mapping**

Run: `npx vitest run worker/test/deepgram-remote.test.ts`
Expected: new duration assertion FAIL first, then PASS after mapping provider metadata.

- [ ] **Step 6: Write RED dubbing-pipeline test**

Use a fake remote ASR that records the URL and returns `{ durationMs: 90_000, segments: [...] }`. Assert the pipeline:

```ts
expect(remoteUrls).toEqual([signedR2Url]);
expect(progressStages).not.toContain('stream_ingest');
expect(stepNames.join(' ')).not.toMatch(/Stream/i);
expect(projectDurationWrites).toContain(90_000);
```

Add a second test where prepared duration and ASR duration are both missing; assert fail closed before translation.

- [ ] **Step 7: Run dubbing RED and replace Stream workflow construction**

Run: `npx vitest run worker/test/zero-stream-dubbing-pipeline.test.ts`
Expected: FAIL because `DubbingWorkflow` still constructs `StreamMediaService` and pipeline stage names contain Stream.

Update `DubbingWorkflow.ts` to construct `R2SourceMediaService` from `PUBLIC_ORIGIN` and the canonical/fallback signing secret. Update pipeline stage names to `preparing_source`, `prepare source`, `transcribe source media`, and persist duration from `source.durationMs ?? asrResult.durationMs` after validating `0 < duration <= 3h`.

- [ ] **Step 8: Run focused dubbing tests GREEN and commit**

Run: `npx vitest run worker/test/r2-source-service.test.ts worker/test/deepgram-remote.test.ts worker/test/zero-stream-dubbing-pipeline.test.ts worker/test/zero-container-dubbing-pipeline.test.ts`
Expected: PASS.

Commit message: `feat(dubbing): transcribe signed R2 source directly`.

---

### Task 3: Add ranged R2 input and bounded multipart output adapters for Mediabunny

**Files:**
- Create: `worker/src/services/media/r2-mediabunny-source.ts`
- Create: `worker/src/services/media/r2-multipart-target.ts`
- Test: `worker/test/r2-mediabunny-source.test.ts`
- Test: `worker/test/r2-multipart-target.test.ts`

**Interfaces:**
- Produces: `createR2MediaSource(bucket, key, options?): Promise<CustomSource>` using Mediabunny `CustomSource`.
- Produces: `createR2MultipartWritable(bucket, key, options?): { writable: WritableStream<StreamTargetChunk>; complete(): Promise<void>; abort(): Promise<void>; stats: { maxBufferedBytes: number } }`.
- Default input cache budget: 8 MiB or less.
- Multipart output part size: `8 * 1024 * 1024` bytes except the final part.

- [ ] **Step 1: Write RED ranged-source tests**

Mock R2 `head` and `get(key, { range: { offset, length } })`. Assert Mediabunny source `getSize()` equals R2 size and `read(10, 20)` results in exactly one R2 ranged read `{ offset: 10, length: 10 }` without loading the whole object.

- [ ] **Step 2: Run ranged-source RED then implement**

Run: `npx vitest run worker/test/r2-mediabunny-source.test.ts`
Expected: FAIL then PASS after implementing `CustomSource({ getSize, read, maxCacheSize, prefetchProfile: 'network' })`.

- [ ] **Step 3: Write RED multipart-target backpressure test**

Feed multiple `StreamTargetChunk` writes whose aggregate exceeds two parts. Assert uploads occur in sequential part numbers, `complete(parts)` receives ordered etags, and `stats.maxBufferedBytes <= 16 * 1024 * 1024`.

- [ ] **Step 4: Implement append-only multipart writer**

Reject non-monotonic target positions with `MP4_REMUX_FAILED` rather than attempting random in-place rewrites. Buffer only until one upload part is ready; await `uploadPart` before accepting unbounded further data. On finalization upload the trailing part, then complete. On any failure call `abort()` and surface `R2_EXPORT_WRITE_FAILED`.

- [ ] **Step 5: Run adapter tests GREEN and commit**

Run: `npx vitest run worker/test/r2-mediabunny-source.test.ts worker/test/r2-multipart-target.test.ts`
Expected: PASS.

Commit message: `feat(media): add bounded R2 mediabunny adapters`.

---

### Task 4: Implement H.264 video-copy + AAC soundtrack MP4 remux directly to R2

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `worker/src/services/media/r2-remux.ts`
- Add tiny deterministic fixture: `worker/test/fixtures/h264-aac-source.mp4`
- Add deterministic PCM fixture: `worker/test/fixtures/dubbed-stereo.pcm`
- Test: `worker/test/r2-remux.test.ts`
- Test: `worker/test/r2-remux-admission.test.ts`

**Interfaces:**
- Produces class `R2RemuxService` with:

```ts
publishDubbedExport(input: {
  projectId: string;
  userId: string;
  sourceObjectKey: string;
  soundtrackObjectKey: string;
  targetLanguage: string;
  exportId: string;
  exportObjectKey: string;
}): Promise<{ exportObjectKey: string; audioTrackUid: string }>;
```

Keep `audioTrackUid` temporarily for caller compatibility, returning `'r2-aac'`; new exports do not write Stream provenance.

- Produces `assertRemuxableSource(source): Promise<{ codec: string; durationSeconds: number }>` that admits H.264/AVC MP4 copy paths and throws `VIDEO_TRANSCODE_REQUIRED` otherwise.

- [ ] **Step 1: Install and lock dependencies**

Run: `npm install mediabunny @mediabunny/aac-encoder`
Expected: `package.json` and lockfile contain both packages.

- [ ] **Step 2: Write RED admission test**

Use the H.264 fixture plus a deliberately unsupported fixture/header mock. Assert baseline H.264 is admitted and unsupported input throws `VIDEO_TRANSCODE_REQUIRED:`.

- [ ] **Step 3: Run admission RED then implement input inspection**

Create a Mediabunny `Input` over `createR2MediaSource`, require readable MP4, exactly one primary video track, and a copyable AVC codec. Do not call a video decoder or encoder.

- [ ] **Step 4: Write RED remux integrity test**

Parse source and output packet sinks and assert:

```ts
expect(outputVideo.codec).toBe(sourceVideo.codec);
expect(outputVideoPacketHashes).toEqual(sourceVideoPacketHashes);
expect(outputAudioTracks).toHaveLength(1);
expect(outputAudioTracks[0].codec).toBe('aac');
expect(Math.abs(outputDuration - expectedSoundtrackDuration)).toBeLessThanOrEqual(0.25);
```

Also assert original source audio packets are absent from the output audio track.

- [ ] **Step 5: Run remux integrity test RED**

Run: `npx vitest run worker/test/r2-remux.test.ts`
Expected: FAIL because remux service does not exist.

- [ ] **Step 6: Implement remux with packet-copy video and AAC audio**

Use Mediabunny `EncodedVideoPacketSource` for original encoded video packets. Register `@mediabunny/aac-encoder` when native AAC is unavailable. Convert the existing PCM soundtrack into bounded `AudioSample` chunks and feed `AudioSampleSource({ codec: 'aac', bitrate: 128_000 })`. Use append-only/fragmented MP4 output and `StreamTarget` over the R2 multipart writable. Feed tracks in timestamp windows and await every `.add()` for backpressure. Never use `BufferTarget` on the production path.

- [ ] **Step 7: Map failures to stable error codes**

AAC setup/encode -> `AUDIO_ENCODE_FAILED`; unsupported copy path -> `VIDEO_TRANSCODE_REQUIRED`; mux/parser/output ordering -> `MP4_REMUX_FAILED`; R2 multipart -> `R2_EXPORT_WRITE_FAILED`.

- [ ] **Step 8: Run remux tests GREEN and commit**

Run: `npx vitest run worker/test/r2-remux.test.ts worker/test/r2-remux-admission.test.ts worker/test/r2-multipart-target.test.ts`
Expected: PASS.

Commit message: `feat(export): remux dubbed MP4 directly to R2`.

---

### Task 5: Wire R2 remux into export workflow and fail unsupported video before expensive render work

**Files:**
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/workflows/zeroContainerExportPipeline.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/routes/export.ts`
- Test: `worker/test/zero-stream-export-workflow.test.ts`
- Test: `worker/test/zero-container-export-admission.test.ts`
- Test: `worker/test/export-route.test.ts`

**Interfaces:**
- Export Workflow constructs `R2RemuxService`, never `StreamMediaService`.
- Standard dubbed export admission performs a cheap remuxability check before TTS generation.
- Subtitle-only export remains independent of media remux.

- [ ] **Step 1: Write RED workflow test rejecting Stream construction**

Mock active export dependencies and assert standard dubbed export completes with only `MEDIA` R2. Do not provide `STREAM`, `CLOUDFLARE_STREAM_API_TOKEN`, or `CLOUDFLARE_ACCOUNT_ID`.

- [ ] **Step 2: Run RED**

Run: `npx vitest run worker/test/zero-stream-export-workflow.test.ts`
Expected: FAIL because `ExportWorkflow` currently requires `env.STREAM` and constructs `StreamMediaService`.

- [ ] **Step 3: Replace workflow publisher**

Remove the Stream binding guard and construct `R2RemuxService` with `MEDIA`. Keep lip-sync qualification and provider-media grants unchanged.

- [ ] **Step 4: Write RED early-admission test**

Use unsupported video and spies for ElevenLabs/TTS. Assert `VIDEO_TRANSCODE_REQUIRED` occurs before `voice.generate()` and soundtrack assembly.

- [ ] **Step 5: Implement early remux admission**

At standard dubbed export start, authorize project and invoke publisher/source inspector before generating voice artifacts. Do not apply the check to subtitle-only exports.

- [ ] **Step 6: Run export tests GREEN and commit**

Run: `npx vitest run worker/test/zero-stream-export-workflow.test.ts worker/test/zero-container-export-admission.test.ts worker/test/export-route.test.ts worker/test/zero-container-export-pipeline.test.ts`
Expected: PASS.

Commit message: `feat(export): remove Stream from active export path`.

---

### Task 6: Remove Stream from production config, admission, readiness, and deployment contract

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/routes/readiness.ts`
- Modify: `worker/src/app.ts`
- Modify: `scripts/verify-deployment.mjs`
- Modify: `tests/deploy-config.test.mjs`
- Modify: `tests/zero-container-config.test.mjs`
- Modify: `tests/verify-deployment.test.mjs`
- Create/modify: `worker/test/r2-only-readiness.test.ts`
- Modify: `worker/test/zero-container-process-admission.test.ts`

**Interfaces:**
- `/api/ready` media contract becomes `media: { r2: 'ready' | 'unavailable', remux: 'ready' | 'unavailable' }`.
- Readiness schema revision becomes 14.
- Process admission requires `MEDIA`, `PUBLIC_ORIGIN`, and canonical/fallback signing secret; it must not require `STREAM`.

- [ ] **Step 1: Write RED deploy-config tests**

Assert `wrangler.jsonc` has no `stream` key and no active `CLOUDFLARE_STREAM_API_TOKEN` requirement while account/topology and D1/R2/Workflow bindings remain unchanged.

- [ ] **Step 2: Write RED readiness/process tests**

A ready env has DB schema 14, `MEDIA`, `PUBLIC_ORIGIN`, signing secret, and remux self-check success, with no Stream/account-id/token. Missing origin/signing/remux capability must be not-ready. Process admission must 503 before job creation if signing config is absent.

- [ ] **Step 3: Run RED suite**

Run: `node --test tests/deploy-config.test.mjs tests/zero-container-config.test.mjs tests/verify-deployment.test.mjs` plus `npx vitest run worker/test/r2-only-readiness.test.ts worker/test/zero-container-process-admission.test.ts`.
Expected: failures proving Stream remains active/schema remains 13.

- [ ] **Step 4: Remove Stream config and update admission/readiness**

Delete `stream` from `wrangler.jsonc`; remove Stream API token/account id from media readiness; keep `PUBLIC_ORIGIN`, `MEDIA`, signing secret, and remux self-check. Rename process errors to `MEDIA_SOURCE_SIGNING_UNAVAILABLE` and `MEDIA_SOURCE_ORIGIN_UNAVAILABLE`.

- [ ] **Step 5: Update deployment verifier**

Set `CURRENT_SCHEMA_REVISION = 14` and require `body.media.r2 === 'ready'` and `body.media.remux === 'ready'`.

- [ ] **Step 6: Run GREEN and commit**

Run the same focused suites; expected PASS.

Commit message: `fix(deploy): make production media runtime R2 only`.

---

### Task 7: Retire active Stream runtime while preserving backward-compatible data lineage

**Files:**
- Remove: `worker/src/services/media/stream.ts`
- Remove: `worker/src/cloudflare/stream.ts`
- Remove/update Stream-only tests: `worker/test/stream-media-service.test.ts`, `worker/test/stream-export-*.test.ts`, `worker/test/project-stream-provenance.test.ts`
- Modify DB repositories only if Stream provenance fields are mandatory; do not alter historical migrations.
- Modify: `src/features/projects/ProjectDashboard.tsx` only for error presentation compatibility
- Test: `src/features/projects/ProjectDashboard.test.tsx`
- Modify: `tests/zero-container-config.test.mjs`

**Interfaces:**
- Active Worker source contains no `StreamMediaService`, `cloudflare/stream`, or Stream API calls.
- Legacy Stream DB fields remain nullable/readable but are never written by new jobs.

- [ ] **Step 1: Add RED active-source guard**

Make the config test scan active Worker source and fail on `StreamMediaService`, `cloudflare/stream`, or `CLOUDFLARE_STREAM_API_TOKEN` imports/usages.

- [ ] **Step 2: Remove dead Stream runtime files only after imports are gone**

Do not rename/drop historical migration files or columns.

- [ ] **Step 3: Preserve historical UI sanitizer and add new error assertion**

Keep old `getByName`/Stream error sanitization. Assert new `VIDEO_TRANSCODE_REQUIRED`/`MP4_REMUX_FAILED` product errors are not rewritten to Stream wording.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test tests/zero-container-config.test.mjs` and `npx vitest run src/features/projects/ProjectDashboard.test.tsx`.
Expected: PASS.

Commit message: `refactor(media): retire Cloudflare Stream runtime`.

---

### Task 8: Update deployment docs and acceptance tests to R2-only architecture

**Files:**
- Modify: `docs/DEPLOYMENT-POLICY.md`
- Modify: `docs/deployment-status.md`
- Modify: `docs/CLOUDFLARE-CROSS-ACCOUNT-WORKERS-ONLY.md`
- Modify: `tests/deployment-status.test.mjs`
- Modify: `tests/phase4c-main-reconciliation-acceptance.test.mjs`
- Modify: `tests/phase4e-lipsync-acceptance.test.mjs` only where Stream assumptions exist
- Modify: `tests/stream-migration.test.mjs` to preserve migration lineage without asserting active Stream runtime

**Interfaces:**
- Docs state backend 6666, gateway/domain 2403, no Containers, no Stream, R2 source/final artifacts, signed source secret, Deepgram remote ASR for long-form, H.264 baseline remux.
- Historical migration tests still require both shipped `0012_*` filenames exactly.

- [ ] **Step 1: Adjust acceptance assertions to RED**

Reject docs/config that list Stream as production dependency; require `MEDIA_SOURCE_SIGNING_SECRET`, schema 14, R2-only remux wording, and unchanged topology.

- [ ] **Step 2: Run `npm run verify:deploy-config` RED**

Expected: only stale Stream/doc assumptions fail.

- [ ] **Step 3: Update docs**

Document `STREAM_SOURCE_SIGNING_SECRET` only as temporary alias; canonical secret is `MEDIA_SOURCE_SIGNING_SECRET`. State no Cloudflare Stream dependency/charges are required by admitted runtime.

- [ ] **Step 4: Run acceptance GREEN and commit**

Run: `npm run verify:deploy-config`
Expected: PASS.

Commit message: `docs(deploy): lock R2-only media architecture`.

---

### Task 9: Full exact-head qualification, PR integration, and production rollout

**Files:**
- No new feature files unless CI exposes a real regression.
- PR body records RED/GREEN run IDs and exact head SHA.

**Interfaces:**
- Exact-head evidence includes unit tests, TypeScript build, checked-in Wrangler dry-run, generated-production dry-run, screenshots/artifact.
- Production success requires backend + gateway Workers Builds and public `/api/ready` schema 14 with R2/remux ready.

- [ ] **Step 1: Push exact branch head and wait for full CI GREEN**

Do not merge any failed/cancelled required check.

- [ ] **Step 2: Compare against latest `main`**

If main moved, inspect overlap, refresh without force, preserve newer migration/gateway/deploy fixes, and rerun exact-head CI.

- [ ] **Step 3: Open PR `feat/r2-only-media-pipeline -> main`**

PR summary:

```text
0 Containers + 0 Cloudflare Stream
R2 signed source -> remote ASR
H.264 packet-copy + AAC soundtrack -> MP4 -> R2
No historical migration rewrite
```

Include exact RED/GREEN run IDs.

- [ ] **Step 4: Wait for fresh PR CI GREEN and merge**

Require mergeable/current base/no unresolved overlap.

- [ ] **Step 5: Verify post-merge GitHub Actions and Workers Builds**

Require backend `dubflow` GREEN on 6666 and gateway `dubflow-gateway` GREEN on 2403.

- [ ] **Step 6: Verify live readiness**

Require `https://yupvox.qs3d.site/api/ready` HTTP 200, `ready: true`, DB ready, schema 14, `media.r2: 'ready'`, `media.remux: 'ready'`.

- [ ] **Step 7: Run one real small H.264 MP4 end-to-end**

Confirm upload -> dubbing -> standard export completes, final MP4 is in R2, source video codec/packets are preserved, dubbed AAC audio is present, and download/playback through the public gateway works without Stream/Containers.

- [ ] **Step 8: Remove old Cloudflare Stream runtime secret/binding only after live qualification**

Deactivate old Stream token/binding in Cloudflare only after Step 7. Keep old signing-secret alias until canonical `MEDIA_SOURCE_SIGNING_SECRET` is confirmed live, then remove alias in a later bounded cleanup.

- [ ] **Step 9: Final verification report**

Report exact main SHA, CI run, backend/gateway build/version IDs, readiness response/schema, live fixture result, and confirmation that active runtime uses neither Containers nor Stream.
