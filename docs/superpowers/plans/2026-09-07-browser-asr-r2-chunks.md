# Browser-prepared R2 ASR chunks implementation plan

> Approved architecture: browser/Web Worker decodes source media into bounded PCM16 mono 16 kHz WAV chunks, uploads them to generation-bound R2 keys, commits a canonical manifest, and the backend reads one prepared chunk at a time for ASR. Server-side AAC decoding/remux is not part of this design.

## Goal

Make long-form source media structurally processable without decoding media inside Cloudflare Workers, without Cloudflare Stream or Containers, and without implicitly authorizing any paid inference. Workers AI remains fail-closed unless the separately merged `PAID_WORKERS_AI_ENABLED=true` opt-in is explicitly supplied.

## Safety constraints

- No production fixture dispatch in this lane.
- No paid provider enablement, top-up, or account mutation.
- No Stream, Containers, FFmpeg server, Node native decoder, or Worker-runtime AAC decoder.
- Do not set `PAID_WORKERS_AI_ENABLED=true` in source/config.
- R2 manifest/chunks are bound to current `sourceGeneration` and `sourceObjectKey`; stale generations fail closed.
- Browser preparation is sequential/backpressured; never materialize decoded audio for the whole 3-hour source at once.
- Each prepared WAV chunk is mono PCM16 at 16 kHz and no longer than 300 seconds.
- Server generates/validates R2 keys; client cannot select arbitrary object keys.

## Canonical R2 layout

```text
projects/{projectId}/asr/source-{sourceGeneration}/chunk-{index}.wav
projects/{projectId}/asr/source-{sourceGeneration}/manifest.json
```

Canonical manifest shape:

```ts
{
  version: 1,
  projectId: string,
  sourceObjectKey: string,
  sourceGeneration: number,
  sampleRate: 16000,
  channels: 1,
  sampleFormat: 's16',
  container: 'wav',
  durationMs: number,
  chunks: Array<{
    index: number,
    objectKey: string,
    offsetMs: number,
    durationMs: number,
    sizeBytes: number,
  }>,
}
```

## Task 1 — RED source and client contracts

**Files**
- Add `tests/browser-asr-r2-chunks.test.mjs`
- Add `src/features/upload/sourceAudioPrep.test.ts`
- Add `src/features/upload/preparedAsrApi.test.ts`
- Modify `src/features/upload/cloudUploadFlow.test.ts`

**RED assertions**
1. Browser preparation is isolated behind a Web Worker and uses existing Mediabunny browser APIs (`BlobSource`, `Conversion`, `WavOutputFormat`, `BufferTarget`), with video discarded and audio forced to mono/16 kHz/s16.
2. Preparation uses bounded trim windows no longer than 300 seconds and emits/upload one chunk at a time rather than collecting the complete decoded source.
3. Client API uploads a chunk with server-derived identity metadata and then calls a separate completion endpoint with ordered chunk metadata.
4. Cloud upload flow becomes: create project → source multipart upload → refresh project/current source generation → conditionally prepare/upload ASR chunks → start processing.
5. Existing short/small source behavior remains possible without forcing browser preparation.

Run the focused tests and then the full CI. The first commit must be RED only because implementation files/endpoints are missing.

## Task 2 — Browser bounded PCM preparation

**Files**
- Add `src/features/upload/sourceAudioPrep.ts`
- Add `src/features/upload/sourceAudioPrep.worker.ts`
- Modify `src/features/projects/projectApi.ts`

**Implementation**
1. Extend `CloudProject` with the current `sourceGeneration` returned by the backend.
2. Worker opens the local `File` via Mediabunny `BlobSource`, discovers primary audio duration/decodability, and converts one trim window at a time to WAV.
3. Conversion output is PCM16 mono 16 kHz; video is discarded.
4. Main-thread helper exposes an async sequential callback/iterator contract; no full-file WAV array is accumulated.
5. Preparation is required when source duration exceeds 300 s or source size exceeds the direct ASR payload ceiling; otherwise return `required:false`.
6. Reject absent/undecodable audio and invalid duration before any R2 ASR-chunk upload.

Run focused Vitest tests until GREEN.

## Task 3 — Authenticated generation-bound R2 chunk upload

**Files**
- Add `src/features/upload/preparedAsrApi.ts`
- Modify `worker/src/routes/uploads.ts`
- Modify `worker/src/services/uploads.ts`
- Modify `worker/test/uploads.test.ts`

**Endpoints**

`PUT /api/projects/:id/uploads/asr/chunks/:index`
- Request body is one WAV chunk.
- Client sends current source generation, offset and duration metadata.
- Server loads current project for the authenticated user and rejects stale generation/missing source.
- Server derives the R2 object key.
- Validate integer index, contiguous-safe bounds, duration `>0 && <=300000`, nonnegative offset, maximum chunk byte size, RIFF/WAVE PCM mono/16 kHz/16-bit header, and nonempty payload.
- Store to R2 and return canonical descriptor including server-derived `objectKey` and actual `sizeBytes`.

`POST /api/projects/:id/uploads/asr/complete`
- Validate current generation/source identity.
- Validate ordered contiguous indices starting at 0, monotonic/contiguous offsets, each duration bound, descriptor key prefix, object existence and stored sizes.
- Write canonical manifest JSON to the generation-bound manifest key.
- Never accept an arbitrary client object key outside the derived prefix.

**RED/GREEN cases**
- stale generation rejected
- chunk >300 s rejected
- oversized chunk rejected
- malformed/non-PCM WAV rejected
- duplicate/noncontiguous indices rejected
- discontinuous offsets rejected
- missing R2 chunk rejected
- source object/generation mismatch rejected

## Task 4 — Client orchestration and backpressure

**Files**
- Modify `src/features/upload/cloudUploadFlow.ts`
- Modify `src/features/upload/cloudUploadFlow.test.ts`
- Use `preparedAsrApi.ts` and `sourceAudioPrep.ts`

**Implementation**
1. After source multipart completes, fetch the project again to obtain authoritative `sourceGeneration` and `sourceObjectKey`.
2. If preparation is required, run Web Worker conversion sequentially.
3. Immediately upload each produced WAV and release its buffer before converting the next chunk.
4. Complete the manifest only after every chunk upload succeeds.
5. Start processing only after required prepared-audio completion succeeds.
6. Any browser decode/upload failure prevents processing start and produces a user-visible upload error through the existing flow.

## Task 5 — Backend manifest reader and chunk-at-a-time ASR

**Files**
- Modify `worker/src/services/media/r2-source.ts`
- Modify `worker/src/workflows/pipeline.ts`
- Modify `worker/test/r2-source-service.test.ts`
- Modify `worker/test/dubbing-workflow.test.ts` or `worker/test/zero-container-dubbing-pipeline.test.ts`

**Implementation**
1. R2 source service can load/validate only the manifest for the project’s current `sourceGeneration`.
2. Manifest validation rechecks exact project/source identity, audio format, ordered contiguous descriptors, duration bounds and R2 key prefix.
3. Expose lazy descriptors/read closures; do not load all WAV chunks at once.
4. Pipeline prefers a valid prepared manifest when present and transcribes each chunk separately, applying each descriptor `offsetMs` exactly once before existing normalization/stitching.
5. For sources that exceed the direct ASR ceiling and lack a valid prepared manifest, fail closed with a prepared-audio-required/long-form-unavailable error; do not invoke a paid fallback.
6. Short/small direct path remains unchanged.
7. The separately merged Workers AI paid-opt-in gate remains authoritative. With production default OFF, prepared media alone cannot trigger Workers AI billing.

**Tests**
- manifest current-generation success
- stale manifest rejection
- lazy one-at-a-time reads
- long source prefers prepared chunks
- offsets applied exactly once
- missing prepared chunks fail before ASR provider work
- paid Workers AI disabled still causes zero `AI.run` calls

## Task 6 — Full verification and integration

1. Run focused client/server tests.
2. Run repository full CI on exact PR head: agent coordination, source/tests/build, Wrangler dry-runs, screenshots and artifacts.
3. Manual diff review for arbitrary R2 key injection, stale-generation acceptance, whole-file decoded buffering, or accidental paid-enable configuration.
4. Refresh against current `main` non-force if needed; rerun exact-head CI.
5. Mark Ready only after exact-head FULL GREEN.
6. Merge with expected-head SHA.
7. Verify post-merge CI on exact new `main`.
8. Do **not** dispatch production media fixture: production runtime inference remains unqualified for the user’s hard zero-charge requirement while Workers AI is disabled by default.
9. Update #91 with source qualification and remaining runtime blocker truthfully.
