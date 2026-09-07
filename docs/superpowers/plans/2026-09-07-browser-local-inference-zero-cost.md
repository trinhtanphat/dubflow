# Browser-local zero-cost ASR + EN→VI implementation plan

> Primary carrier: PR #137. Approved design: `feat/browser-local-inference-zero-cost-20260907` commit `c3170be0662e3d5272714936f307936d2afae9c8`.
>
> Reviewed base: `main` `848dd48cd94115a502a23faa8b8bb83b48381bc8`.
>
> Paid resources are forbidden. This plan must not enable or dispatch Workers AI, Deepgram, Google Translate, Grok/xAI, ElevenLabs, Sync Labs, Stream, Containers, or another metered provider in the qualified lane.

## Goal

Replace the superseded browser-prepared-R2/backend-ASR direction on PR #137 with the approved browser-local inference path:

`private R2 source → browser decode → local Whisper → local Marian EN→VI → atomic durable commit → existing browser Piper PCM → existing modern R2 dubbed export/remux`

The v1 lane is EN→VI only, source <= 5 minutes and <= 24 MiB, <= 500 canonical segments, one durable project-unique speaker, and <= 2 MiB client-inference commit payload.

## Non-negotiable integration constraints

- Keep PR #137 as the single primary carrier for #91; do not create a competing PR.
- Keep PR #128 sequenced after #91 and avoid its cleanup paths (`worker/src/app.ts`, `worker/src/routes/readiness.ts`, `scripts/verify-deployment.mjs`, `worker/src/workflows/DubbingWorkflow.ts`, voice cleanup files).
- Do not edit, rename, or renumber any deployed migration. Historical `0012_stream_media.sql` and `0012_visual_lipsync.sql` stay byte-for-byte immutable.
- Re-fetch `main` and the migrations directory immediately before allocating a new migration number. Use `0013_browser_local_translation_engine.sql` only if `0013` is still unused.
- `schemaRevision=14` is a readiness capability contract, not a migration counter. Do not bump it merely because a CHECK-only migration is added. Migration-chain tests must prove current readiness schema is preserved.
- Never call `/api/projects/:id/process`, translation process/retranslate routes, or `/api/voice/capabilities` from the local coordinator.
- `PAID_WORKERS_AI_ENABLED` remains false/off for this lane. No source/config change may turn it on.
- No force push, CI bypass, RED merge, or production qualification claim without terminal real-media evidence.

## Task 0 — Reconcile the old #137 scope before building the new lane

**Keep if still useful**

- `src/features/upload/sourceAudioPrep.ts`
- `src/features/upload/sourceAudioPrep.worker.ts`
- `src/features/upload/sourceAudioPrep.test.ts`
- the minimal `CloudProject.sourceGeneration` type addition in `src/features/projects/projectApi.ts`
- browser media decode primitives that can produce bounded local PCM without server inference.

**Restore to current `main` / delete if added only for the superseded backend-ASR path**

- `docs/superpowers/plans/2026-09-07-browser-asr-r2-chunks.md`
- `tests/browser-asr-r2-chunks.test.mjs`
- `src/features/upload/preparedAsrApi.ts`
- `src/features/upload/preparedAsrApi.test.ts`
- backend-ASR-specific changes in `src/features/upload/cloudUploadFlow.ts` and `.test.ts`
- backend-ASR chunk upload changes in `worker/src/routes/uploads.ts`, `worker/src/services/uploads.ts`, `worker/test/uploads.test.ts`
- prepared-manifest/backend transcription changes in `worker/src/services/media/r2-source.ts` and `worker/src/workflows/pipeline.ts`
- any change to `worker/src/workflows/DubbingWorkflow.ts`.

Do this by comparing each path against exact current `main`; do not blindly revert browser decode work that is reusable.

## Task 1 — RED source contract for the local lane

**Files**

- Add `tests/browser-local-inference-zero-cost.test.mjs`.
- Modify `package.json` only to add the new source-contract test and exact Transformers.js dependency when moving GREEN.

**RED assertions**

1. `@huggingface/transformers` exact version is `4.2.0` (no caret/tilde).
2. Browser ASR constants contain exactly:
   - model `onnx-community/whisper-tiny.en`
   - revision `2575352d61be1bf7225cf8f8b268a4678025fc58`
   - task `automatic-speech-recognition`
   - dtype `q8`.
3. Browser translation constants contain exactly:
   - model `Xenova/opus-mt-en-vi`
   - revision `3f5f449333cbc7ecaa9eec16ee9e37682f036b8e`
   - task `translation`
   - dtype `q8`.
4. Model imports live in module workers, not React main-thread modules.
5. Local coordinator source contains no call to `/process`, translation process/retranslate, voice capabilities, Workers AI, Deepgram, Google, Grok/xAI, ElevenLabs, Sync Labs, Stream, or Containers.
6. Local commit endpoint is exactly `PUT /api/projects/:id/client-inference/vi`.
7. Limits are source-level constants: 24 MiB, 300000 ms, 500 segments, 2 MiB body, 1000 ms duration tolerance.
8. Project-unique speaker ID uses project identity; repository-global literal `browser-local-speaker-1` is forbidden.
9. The old backend-ASR prepared-chunk source contract is absent from `verify:deploy-config` after reconciliation.

Run `npm run verify:deploy-config`. Commit this gate in intentional RED before implementation if the repository workflow permits a red carrier commit; otherwise keep it local to the branch sequence and record the exact failing assertion in the PR body.

## Task 2 — RED append-only migration for truthful local translation provenance

**Files**

- Add the next unused migration, expected `migrations/0013_browser_local_translation_engine.sql` only after latest-main allocation check.
- Add `worker/test/browser-local-translation-migration.test.ts` or extend the existing full migration-chain acceptance test if that is the repository convention.

**Required behavior**

Legacy `segments.translation_engine` must admit `browser-opus-mt` without mislabeling local work as `workers-ai` or `google`. The migration must preserve all existing segment data, IDs, FK behavior, indexes, split lineage, translated/voice state, and every previously admitted engine value.

SQLite cannot edit a CHECK constraint in place. Rebuild only the `segments` table as required by SQLite, preserving the current schema from the complete migration chain rather than reconstructing the 0001-era shape. Use `PRAGMA defer_foreign_keys = ON` as appropriate, copy rows explicitly, drop/rename in the safe order, and recreate every current segment index/constraint.

**RED/GREEN tests**

- full migration chain from 0001 through the new migration succeeds;
- legacy engine rows survive byte-for-byte equivalent values;
- `browser-opus-mt` insert/update succeeds after the new migration;
- invalid arbitrary engine remains rejected if the rebuilt CHECK remains allowlisted;
- split-parent lineage/index remains present;
- modern `segment_translations` rows remain unaffected;
- historical Stream migration filenames/content are untouched;
- readiness structural probes still satisfy schema revision 14.

Do not apply this migration to production from GitHub Actions. Production application is a later explicit deployment gate.

## Task 3 — RED server domain validation for client inference

**Files**

- Add `worker/src/domain/client-inference.ts`.
- Add focused unit tests, preferably `worker/test/client-inference-route.test.ts` for request normalization/error mapping and/or a domain-focused test if the repo pattern supports it.

**Hard-coded server constants**

- ASR provider: `browser-whisper`
- ASR model/revision: exact approved values
- translation provider: `browser-opus-mt`
- translation model/revision: exact approved values
- max bytes: `24 * 1024 * 1024`
- max duration: `300_000`
- duration tolerance: `1_000`
- max segments: `500`
- max request body: `2 * 1024 * 1024`

**Validation**

- payload is an object and body-size admission happens before expensive parse/mutation where Hono permits;
- source generation is a positive integer;
- source object key is a non-empty exact string;
- duration is positive integer <= 300000;
- exact provider/model/revision tuples only;
- 1..500 ASR segments;
- use existing `normalizeAsrSegments` semantics plus local-lane checks: trimmed nonempty source text, min 100 ms, ordered/nonoverlap, inside duration;
- one-to-one translation item set with no missing/unknown/duplicate segment IDs;
- translated text trimmed/nonempty and bounded to a defensive per-item length consistent with request cap;
- caller-supplied speaker IDs are not accepted; server derives `browser-local:<projectId>:speaker-1`.

Map malformed input to `LOCAL_INFERENCE_INVALID` 400 without leaking payload/model cache detail.

## Task 4 — RED/GREEN atomic persistence repository

**Files**

- Add `worker/src/db/client-inference.ts`.
- Add `worker/test/client-inference-persistence.test.ts`.

Use `D1DatabaseLike` and one ordered `db.batch()` for the mutation after all read-side validation is complete. If `db.batch` is unavailable, fail closed with `LOCAL_INFERENCE_COMMIT_FAILED`; do not simulate atomicity with sequential writes.

**Read-side admission before mutation**

Load in as few statements as practical:

- authenticated project (`id`, `user_id`, `source_language`, `source_generation`, `source_object_key`, `size_bytes`, `duration_ms`, `status`);
- enabled `vi` target and its status;
- current `project_exports` busy state.

Reject:

- project missing/not owned;
- source language != `en`;
- vi target not enabled;
- source missing or size unknown/>24 MiB;
- submitted source generation/object key mismatch -> `LOCAL_INFERENCE_SOURCE_CONFLICT` 409 and return only safe canonical source metadata;
- canonical duration conflicts by >1000 ms or exceeds limit;
- project `processing`;
- vi target `translating` or `exporting`;
- any `project_exports` row `pending` or `exporting`.

**Single batch mutation order**

1. invalidate current project exports for vi (completed/failed become invalidated; admission already rejects pending/exporting);
2. delete old project `segment_translations`/segments/speakers in FK-safe order as required by schema;
3. insert/upsert one speaker ID `browser-local:<projectId>:speaker-1` with neutral labels;
4. insert canonical source segments with `translation_engine='browser-opus-mt'`, `translation_status='completed'`, `voice_status='pending'`, `dubbed_object_key=NULL`, translated Vietnamese mirror, and version values consistent with new canonical replacement semantics;
5. insert completed `vi` `segment_translations` rows with `translation_engine='browser-opus-mt'`, voice pending, exact source-segment version/context fields expected by existing readers;
6. set canonical duration only when previously absent (or retain canonical when within tolerance);
7. set project `status='needs_review'`, clear legacy current export pointer if required by existing readers, update timestamp;
8. set vi target `status='needs_review'`.

After batch success, read canonical server truth and return project source metadata, speaker, segments, vi variants, and exact model provenance.

**Tests**

- happy path emits one batch and canonical response;
- source generation/object conflict performs zero writes;
- duration conflict zero writes;
- unsupported/busy states zero writes;
- global speaker collision is impossible across two projects;
- no partial state is exposed on simulated batch failure;
- every source segment has exactly one completed vi variant;
- provenance is `browser-opus-mt` in both modern and legacy reads;
- previous export becomes invalidated/cleared;
- voice stays pending until browser Piper uploads exact-version PCM.

## Task 5 — Authenticated route without touching app.ts

**Files**

- Modify `worker/src/routes/projects.ts`.
- Add/complete `worker/test/client-inference-route.test.ts`.

Extend `createProjectsRoutes()` with a separately injectable client-inference store/factory so existing project route tests remain easy to isolate. Because `/api/projects` is already mounted in `worker/src/app.ts`, adding `PUT '/:id/client-inference/vi'` here avoids #128's `app.ts` reservation.

Route steps:

1. reject request body >2 MiB using `content-length` when present and bounded body read in all cases;
2. parse/normalize local inference request;
3. call repository with `projectId` and current authenticated user;
4. return 200 canonical result;
5. map source conflict to 409 `LOCAL_INFERENCE_SOURCE_CONFLICT`;
6. map busy to 409 `LOCAL_INFERENCE_BUSY`;
7. map validation to 400 `LOCAL_INFERENCE_INVALID`;
8. unknown project to 404;
9. sanitize unexpected persistence error to 500 `LOCAL_INFERENCE_COMMIT_FAILED`.

The route contains no provider binding and performs no inference.

## Task 6 — Browser source decode primitive for Whisper

**Files**

- Reconcile `src/features/upload/sourceAudioPrep.ts` and worker/test from old #137.

Change the reusable contract from “produce uploadable WAV chunks for backend ASR” to “produce local mono Float32 PCM 16 kHz for bounded <=5 minute input”. For v1 the complete decoded audio may be materialized only after source admission proves <=5 minutes/24 MiB; do not carry the old 3-hour chunk architecture into this lane.

The worker owns decode. Main thread gets a transferable `Float32Array` plus duration/sample-rate metadata. Reject no-audio/unsupported decode with `LOCAL_SOURCE_DECODE_FAILED`.

Admission must happen before model download when canonical source size/duration already disqualifies the source.

## Task 7 — Browser Whisper worker

**Files**

- Add `src/features/local-inference/browserAsr.worker.ts`.
- Add focused worker protocol tests where feasible without downloading the model; inject/mock the pipeline factory at coordinator boundary.
- Modify `package.json` to exact-pin `@huggingface/transformers` `4.2.0`.

Worker behavior:

- lazy dynamic import `@huggingface/transformers` inside worker;
- initialize `pipeline('automatic-speech-recognition', exactModel, { revision: exactRevision, dtype: 'q8', device: 'webgpu' })`;
- retry initialization once with WASM only when WebGPU init is unsupported/fails before inference;
- do not switch devices/providers after inference has begun;
- consume mono Float32 16 kHz;
- request timestamped chunks;
- post progress/model download events without exposing cache internals;
- normalize timestamps to ms but leave final legal segment validation to coordinator/server;
- dispose pipeline/session on explicit shutdown.

No network call other than Transformers.js model asset loading may be authored in this worker.

## Task 8 — Browser EN→VI Marian worker

**Files**

- Add `src/features/local-inference/browserTranslation.worker.ts`.

Behavior mirrors Task 7 but task/model/revision are the approved EN→VI values. Translate one normalized English segment at a time to bound memory. Every output must be a nonempty string; otherwise fail the whole pre-commit run.

Dispose Whisper before Marian starts, and Marian before Piper starts, so Whisper/Marian/Piper are not resident simultaneously when avoidable.

## Task 9 — Local coordinator + API client

**Files**

- Add `src/features/local-inference/localInferenceCoordinator.ts`.
- Add `src/features/local-inference/localInferenceCoordinator.test.ts`.
- Modify `src/features/projects/projectApi.ts` with the minimal APIs/types required to fetch canonical source metadata and call client-inference commit.

Coordinator phases:

1. fetch authoritative project + vi language/variant state;
2. artifact-resume check: if canonical current-generation local-inference artifacts are already complete, skip ASR/translation;
3. admission EN→VI, source key/generation/size/duration;
4. fetch signed/private source media through the existing DubFlow media path;
5. decode mono Float32 16 kHz;
6. run Whisper worker;
7. normalize legal 100ms+ ordered/nonoverlap segments, derive client UUIDs, fail `LOCAL_ASR_EMPTY` if none;
8. terminate Whisper worker;
9. run Marian sequentially;
10. terminate Marian worker;
11. submit one atomic client-inference commit with captured source generation/object key;
12. on 409 source conflict, discard local artifacts and require a fresh run;
13. refetch canonical vi variants;
14. return canonical variants to Studio for existing Piper preload.

The coordinator must not contain a remote fallback branch. Tests inject fake workers/fetch and assert the complete URL allow/deny contract.

## Task 10 — Studio explicit zero-cost action + Piper handoff

**Files**

- Modify `src/app/StudioShell.tsx` and the smallest existing Studio presentation/context files only if required.

Add an explicit action for eligible cloud EN→VI projects such as `Process locally (zero-cost)`. Do not silently replace normal paid-provider actions.

UI state phases:

- Preparing source
- Downloading ASR model
- Transcribing locally
- Downloading translation model
- Translating locally
- Saving transcript
- Preparing Vietnamese voices
- Exporting

After local commit, reuse existing `getTranslationVariants`, `BrowserPiperClient`, `preloadVietnameseVoices`, and `uploadVietnameseVoicePcm`; start Piper only from canonical server variants. Never call `fetchVoiceCapabilities()` as admission for this local action.

On exact-version PCM completion, reuse the existing modern language export path. Existing manual edit/export behavior remains unchanged.

## Task 11 — Reconcile old #137 files to minimal diff

Before full verification, compare every changed file against latest main and remove old backend-ASR artifacts completely unless now required by local decode:

- no prepared ASR R2 manifest API;
- no prepared-ASR R2 chunk upload route;
- no workflow/pipeline preference for prepared R2 ASR chunks;
- no `bucket` injection added to DubbingWorkflow;
- no source contract describing server ASR over browser-prepared chunks.

Update PR reservations/body to exact final changed paths.

## Task 12 — Exact-head verification

Run/require on exact PR head:

- source-contract tests including `browser-local-inference-zero-cost.test.mjs`;
- full migration chain;
- focused client inference domain/persistence/route tests;
- focused browser local coordinator/unit tests;
- existing Piper exact-version tests;
- `npm run verify` / repository canonical source-tests-build command;
- Wrangler dry-runs already required by CI;
- screenshots/artifacts if repo CI requires them.

Review diff for:

- any paid opt-in becoming true;
- any hidden fallback path;
- any provider credential or signed URL leakage;
- any source-generation race;
- non-atomic D1 writes;
- stale/false provenance;
- migration lineage edits;
- whole-file >5 minute browser buffering;
- overlap with #128.

If main moved, reconcile non-force and rerun exact-head CI. Mark Ready only when required checks are terminal green/current/mergeable. Merge with expected-head SHA, then verify post-merge CI on exact new main.

## Task 13 — Production migration/deployment gate

Do not claim production qualification from source merge alone.

After Workers Builds deploys the merged main, prove whether the new D1 migration is automatically applied. If current deployment tooling does not apply D1 migrations, production remains blocked until an explicit authorized D1 migration action is performed outside this GitHub CI lane. Do not create a GitHub Action that mutates production merely to bypass this gate.

Read `/api/ready` after deploy; schema revision should remain 14 unless a separately justified readiness capability change was introduced.

## Task 14 — Real browser production fixture for #91

The existing Node production fixture is insufficient to prove browser-local Whisper/Marian/Piper. Build/use a real browser fixture only after source/deploy/migration gates are green.

Terminal evidence must prove:

1. schema-14 R2/remux readiness;
2. authorized small H.264/AAC source upload;
3. local Whisper runs with exact model/revision;
4. one durable project-unique speaker + canonical segments;
5. local Marian EN→VI completed variants with `browser-opus-mt` provenance;
6. no metered ASR/translation/TTS network request;
7. browser Piper exact-version PCM durable uploads;
8. UI-triggered modern dubbed export;
9. reload reuses durable artifacts/export identity;
10. final private-R2 MP4 is H.264 + AAC;
11. output H.264 elementary stream SHA exactly matches source;
12. frontend build SHA, backend version, gateway version, model IDs/revisions, project/job/export IDs are recorded.

Only then update #91 with exact evidence and close it. Only after #91 PASS may #128 be refreshed/revalidated for merge.
