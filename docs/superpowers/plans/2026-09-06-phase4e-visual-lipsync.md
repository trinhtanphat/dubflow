# DubFlow Phase 4E Optional Visual Lip-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional fail-closed visual lip-sync export stage that preserves the already-rendered dubbed video as fallback and publishes a canonical lip-synced MP4 only when a real provider succeeds.

**Architecture:** Use a `LipSyncProvider` boundary with Sync Labs as the first implementation. The normal DubFlow export remains the source of truth: after the dubbed MP4 is rendered, the media container extracts its final mixed audio into a project-scoped WAV sidecar; short-lived hash-only provider-media grants stream the dubbed MP4 and WAV from private R2 to Sync Labs over HTTPS. The Workflow submits `POST /v2/generate`, polls `GET /v2/generate/{id}?wait=true`, streams the provider output back into canonical R2, persists lip-sync state, and leaves the standard dubbed artifact usable on every provider failure.

**Tech Stack:** TypeScript, Hono, Cloudflare Workflows/R2/D1/Containers, Vitest, Node test runner, FFmpeg, Sync Labs REST API v2.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4e-visual-lipsync-design.md`

## Global Constraints

- Phase 4E starts after Phase 4D/current audio export is stable; it never reimplements translation, TTS, diarization, or audio mixing.
- Standard dubbed export remains unchanged when lip-sync is not requested.
- Lip-sync is fail-closed and unavailable unless `SYNC_API_KEY` is configured.
- Sync Labs input URLs are short-lived bearer grants to exact project-scoped objects; no permanent public R2 bucket is introduced.
- Provider grant tokens are random 256-bit secrets; only SHA-256 hashes are stored in D1.
- Provider access URLs use canonical origin `https://yupvox.qs3d.site`, expire after 15 minutes, and expose no user identity or provider credential.
- Sync Labs API credentials are sent only in the `x-api-key` header from the Worker.
- Large provider outputs are streamed into R2; the Worker must not buffer full media files in memory.
- Canonical lip-sync output is `projects/{projectId}/exports/{targetLanguage}/{exportId}.lipsync.mp4`.
- A failed lip-sync request must preserve the standard `.../{exportId}.mp4` artifact and must not mark visual processing completed.
- Runtime remains UNQUALIFIED until a real supported fixture completes end-to-end.

---

### Task 1: Persist lip-sync state and provider media grants

**Files:**
- Create: `migrations/0011_visual_lipsync.sql`
- Modify: `worker/src/db/project-exports.ts`
- Create: `worker/src/db/provider-media-grants.ts`
- Test: `worker/src/db/project-exports.test.ts`
- Test: `worker/src/db/provider-media-grants.test.ts`
- Modify: `tests/full-migration-chain.test.mjs`

**Interfaces:**
- Export fields: `lip_sync_requested`, `lip_sync_provider`, `lip_sync_status`, `lip_sync_object_key`.
- Status union: `not_requested | queued | processing | completed | failed`.
- Provider grant row stores `id`, `project_id`, `object_key`, `token_hash`, `expires_at`, `consumed_at`.
- Grant tokens never persist plaintext.

- [ ] **Step 1: Write failing migration/repository tests**

```ts
expect(exportRow).toMatchObject({
  lipSyncRequested: false,
  lipSyncProvider: null,
  lipSyncStatus: 'not_requested',
  lipSyncObjectKey: null,
});
```

```ts
const grant = await store.resolveActive(id, tokenHash, now);
expect(grant?.objectKey).toBe('projects/p1/exports/vi/e1.mp4');
```

- [ ] **Step 2: Run focused repository tests and full migration-chain test; confirm RED**
- [ ] **Step 3: Add forward-only migration 0011 with CHECK constraints and indexes on active/expiry lookup**
- [ ] **Step 4: Extend `ProjectExportRepository` read/write methods for lip-sync lifecycle without changing standard completion semantics**
- [ ] **Step 5: Implement provider grant create/resolve/revoke helpers using exact project object-key validation and expiry**
- [ ] **Step 6: Re-run focused and migration tests; confirm GREEN**
- [ ] **Step 7: Commit `feat(lipsync): persist visual processing state`**

### Task 2: Produce a canonical dubbed-audio sidecar

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/server.mjs`
- Create: `containers/ffmpeg/extract-export-audio.mjs`
- Modify: `containers/ffmpeg/Dockerfile`
- Test: `worker/src/services/media/container.test.ts`
- Test: `containers/ffmpeg/extract-export-audio.test.mjs`

**Interfaces:**
- `MediaProcessor.extractExportAudio(projectId, exportVideoObjectKey, targetLanguage, exportId): Promise<{ audioObjectKey: string }>`.
- Canonical sidecar key: `projects/{projectId}/exports/{targetLanguage}/{exportId}.audio.wav`.

- [ ] **Step 1: Add failing tests for exact export-video prefix, target language/export id validation, and returned canonical audio key**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Add container endpoint `POST /extract-export-audio`; download the normal dubbed MP4 through `media.r2`, run FFmpeg `-vn -ar 48000 -ac 2 -c:a pcm_s16le`, upload WAV through `media.r2`**
- [ ] **Step 4: Add strict response validation in `ContainerMediaProcessor`**
- [ ] **Step 5: Re-run focused tests and confirm GREEN**
- [ ] **Step 6: Commit `feat(media): publish dubbed audio sidecar`**

### Task 3: Short-lived provider media delivery

**Files:**
- Create: `worker/src/security/provider-media-token.ts`
- Create: `worker/src/routes/provider-media.ts`
- Modify: `worker/src/app.ts`
- Test: `worker/src/security/provider-media-token.test.ts`
- Test: `worker/src/routes/provider-media.test.ts`

**Interfaces:**
- `createProviderMediaToken()` returns `{ token, tokenHash, tokenHint }` using 32 random bytes.
- Public route: `GET /api/provider-media/:grantId?token=...`.
- Route streams exactly the stored object using the shared Range implementation and `Referrer-Policy: no-referrer`.

- [ ] **Step 1: Write failing tests for 256-bit token entropy, hash-only persistence contract, expired/wrong/reused token convergence on 404, and successful streaming**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Reuse the existing SHA-256/share-token pattern without sharing user-facing share records**
- [ ] **Step 4: Implement public provider-media route with no user auth, exact active-grant resolution, no directory/listing behavior, no cacheable bearer response, and no secret logging**
- [ ] **Step 5: Mark a grant consumed only after a successful 200/206 read; allow multiple Range reads for the same provider while unexpired by recording first access rather than invalidating immediately**
- [ ] **Step 6: Re-run focused tests and confirm GREEN**
- [ ] **Step 7: Commit `feat(lipsync): add short-lived provider media grants`**

### Task 4: Sync Labs provider boundary

**Files:**
- Create: `worker/src/services/lipsync/types.ts`
- Create: `worker/src/services/lipsync/sync-labs.ts`
- Test: `worker/src/services/lipsync/sync-labs.test.ts`
- Modify: `worker/src/env.ts`

**Interfaces:**
- `LipSyncProvider` exposes `id`, `available`, `render(input)`.
- `SyncLabsLipSyncProvider` uses base URL `https://api.sync.so`, model default `sync-3`, `POST /v2/generate`, then `GET /v2/generate/{id}?wait=true`.
- Input is exactly one dubbed-video URL and one dubbed-audio URL.
- Output is provider job metadata plus `outputUrl`; canonical R2 publication is owned by orchestration, not the provider class.

- [ ] **Step 1: Write failing tests for unconfigured key -> unavailable, exact `x-api-key`, exact two-input JSON, accepted PENDING/PROCESSING states, COMPLETED output, provider FAILED/REJECTED normalization, malformed response, and bounded polling**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Implement provider with request timeout via `AbortController`; normalize raw errors into `LIP_SYNC_FAILED`, `LIP_SYNC_TIMEOUT`, or `LIP_SYNC_RESPONSE_INVALID`**
- [ ] **Step 4: Poll with `wait=true`, a bounded attempt count, and Workflow step boundaries so long waits remain durable/retry-safe**
- [ ] **Step 5: Re-run provider tests and confirm GREEN**
- [ ] **Step 6: Commit `feat(lipsync): add Sync Labs provider`**

### Task 5: Lip-sync admission and capability API

**Files:**
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `src/features/export/batchExportApi.ts`
- Test: `worker/src/routes/export.test.ts`
- Test: `src/features/export/batchExportApi.test.ts`

**Interfaces:**
- Dubbed export request gains `visualMode?: 'standard' | 'lip_sync'`, default `standard`.
- Subtitle export rejects `lip_sync`.
- Export capability response includes `{ visualLipSync: { available, provider } }`.

- [ ] **Step 1: Add failing tests for standard default, explicit lip-sync, invalid mode, subtitle+lip-sync rejection, and missing `SYNC_API_KEY` -> `503 LIP_SYNC_UNAVAILABLE` before job/provider work**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Normalize request mode, persist `lip_sync_requested`, and pass it into Workflow params**
- [ ] **Step 4: Expose capability based on configured Sync Labs provider, without returning any API key or provider account data**
- [ ] **Step 5: Re-run focused tests and confirm GREEN**
- [ ] **Step 6: Commit `feat(export): admit optional visual lip sync`**

### Task 6: Durable lip-sync orchestration, output streaming, and usage

**Files:**
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/src/domain/usage.ts` if needed
- Test: `worker/src/workflows/exportPipeline.test.ts`
- Test: `worker/src/workflows/ExportWorkflow.test.ts`
- Modify: `tests/phase3b-usage-acceptance.test.mjs`

**Interfaces:**
- Usage kind: `lip_sync_video_second`.
- Operation key includes job retry generation, target language, export id, and provider id.
- Workflow owns provider grants and canonical R2 publication.

- [ ] **Step 1: Add failing tests proving standard export never invokes lip-sync; requested lip-sync begins only after normal export exists; provider failure preserves normal artifact; completed canonical lip-sync artifact is reused; usage completion is idempotent**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: After normal MP4 completion, extract/reuse audio sidecar, create two 15-minute provider grants, and build canonical HTTPS input URLs**
- [ ] **Step 4: Mark export visual state queued/processing, invoke Sync Labs with provider telemetry, and meter qualified video duration seconds using existing started/completed operation semantics**
- [ ] **Step 5: On provider COMPLETED, `fetch(outputUrl)` server-side and stream `response.body` directly to `env.MEDIA.put(canonicalLipSyncKey, response.body)`; validate status/content and never return provider URL as canonical output**
- [ ] **Step 6: Persist completed lip-sync object; on failure persist `failed` visual state while leaving `exportObjectKey` untouched**
- [ ] **Step 7: Revoke/expire provider grants after terminal state; cleanup is best-effort and must not overwrite the primary provider error**
- [ ] **Step 8: Re-run focused and accounting tests; confirm GREEN**
- [ ] **Step 9: Commit `feat(lipsync): orchestrate durable visual processing`**

### Task 7: Studio visual-mode UX and fallback behavior

**Files:**
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batchExportApi.ts`
- Modify: `src/features/export/batch-export.css`
- Modify relevant Studio project/export state component(s) discovered by import graph

**Interfaces:**
- Visual choice: `Standard dubbed video` / `Visual lip-sync`.
- Lip-sync is disabled with an explicit reason when unavailable.
- Failed lip-sync shows normal dubbed artifact as fallback, with retry action.

- [ ] **Step 1: Write failing UI tests for fail-closed control, request propagation, queued/processing/failed/completed labels, retry, and standard-download fallback**
- [ ] **Step 2: Run focused tests and confirm RED**
- [ ] **Step 3: Implement controls/state rendering without implying completion before backend status is completed**
- [ ] **Step 4: Re-run UI tests and confirm GREEN**
- [ ] **Step 5: Commit `feat(studio): add optional visual lip sync controls`**

### Task 8: Acceptance, security regression, and live qualification

**Files:**
- Create: `tests/phase4e-lipsync-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`
- Modify: `docs/DEPLOYMENT-POLICY.md` only if a provider-specific deployment secret rule needs explicit documentation

**Interfaces:**
- Source acceptance proves provider boundary, fail-closed admission, short-lived grant security, canonical output paths, standard fallback, and no GitHub production deploy.

- [ ] **Step 1: Add failing source-acceptance checks and wire them into `verify:deploy-config`**
- [ ] **Step 2: Confirm RED, then complete any missing source/docs wiring**
- [ ] **Step 3: Run `npm run verify`**
- [ ] **Step 4: Run `npx wrangler deploy --dry-run`**
- [ ] **Step 5: Push exact head and require GitHub CI FULL GREEN before merge**
- [ ] **Step 6: After merge, require Workers Builds success on exact main SHA**
- [ ] **Step 7: With `SYNC_API_KEY` configured, run one supported real fixture from normal dubbed export -> short-lived provider fetch -> Sync generation -> canonical R2 lip-sync output -> owner download; only then mark Phase 4E runtime PASS**
- [ ] **Step 8: Commit `feat: complete Phase 4E optional visual lip sync`**
