# Zero-Cost Browser-Local ASR + EN→VI Translation Design

Date: 2026-09-07
Status: Approved for implementation
Reviewed against `main`: `848dd48cd94115a502a23faa8b8bb83b48381bc8`
Issue: #91
Paid-Resources: FORBIDDEN

## Goal

Qualify the production media path without metered inference. The browser performs source audio decode, Whisper ASR, English-to-Vietnamese Marian translation, and the existing Piper Vietnamese TTS. The backend only authenticates, validates, durably commits browser-computed artifacts, and performs the existing private-R2 export/remux path.

Canonical flow:

```text
private R2 source
  -> browser decode
  -> browser Whisper ASR
  -> browser EN→VI Marian translation
  -> atomic durable client-inference commit
  -> existing browser Piper exact-version PCM cache
  -> existing R2 dubbed export/remux
```

## Hard cost boundary

- `Paid-Resources: FORBIDDEN`.
- Never invoke Workers AI, Deepgram, Google Translate, Grok/xAI, ElevenLabs, Sync Labs, Cloudflare Stream, Containers, or another metered inference/resource from this lane.
- Never call `/api/projects/:id/process`, server translation process/retranslate routes, or `/api/voice/capabilities` for local-lane admission.
- `PAID_WORKERS_AI_ENABLED` remains OFF for this lane.
- Any browser/runtime/model/validation error fails closed. There is no provider fallback.

## Bounded v1 admission

- source language: exact `en`
- target language: exact `vi`
- source size: `<= 24 MiB`
- source duration: `> 0 && <= 300000 ms`
- maximum durable segments: `500`
- maximum commit payload: `2 MiB`
- duration tolerance against an existing canonical duration: `<= 1000 ms` absolute
- minimum segment duration: existing `MIN_SEGMENT_MS = 100`
- timing: integer milliseconds, ordered, non-overlapping, inside source duration
- source/translated text: non-empty after trim
- one durable speaker only; no diarization claim
- speaker id: deterministic project-unique `browser-local:<projectId>:speaker-1`
- durable commit must match current authenticated `sourceObjectKey` and `sourceGeneration`

## Immutable browser inference pins

Package:

```text
@huggingface/transformers = 4.2.0
```

ASR:

```text
model: onnx-community/whisper-tiny.en
revision: 2575352d61be1bf7225cf8f8b268a4678025fc58
task: automatic-speech-recognition
dtype: q8
preferred device: webgpu
fallback: wasm only when WebGPU initialization fails before inference
```

Translation:

```text
model: Xenova/opus-mt-en-vi
revision: 3f5f449333cbc7ecaa9eec16ee9e37682f036b8e
task: translation
dtype: q8
provenance: browser-opus-mt
preferred device: webgpu when initialization succeeds
fallback: wasm
```

Model files may come from Hugging Face Hub/CDN, but inference executes locally through Transformers.js. Media, transcript text, and translated text are never sent to a hosted inference API. Exact pinned revisions must fail closed if unavailable; never auto-switch model/revision/provider.

## Browser worker lifecycle

Use ES-module browser workers, not React main-thread inference.

`browserAsr.worker.ts`:
- lazy-import `@huggingface/transformers`;
- consume mono Float32 PCM at 16 kHz;
- return timestamped Whisper chunks and progress events;
- dispose after transcript materializes.

`browserTranslation.worker.ts`:
- lazy-import `@huggingface/transformers`;
- translate normalized segments sequentially;
- return Vietnamese text keyed by local segment id;
- dispose after translations materialize.

Avoid keeping Whisper, Marian, and Piper resident simultaneously when possible. Cached model assets may remain in browser cache after worker disposal.

## Browser decode and normalization

Use the existing authenticated/signed private-R2 media path and the browser-supported media decode boundary. Do not expose the source bucket publicly and do not add a server decoder/transcoder.

Before model work, capture authoritative `sourceObjectKey`, `sourceGeneration`, `sizeBytes`, and known `durationMs`. Reject ineligible language, missing source, >24 MiB, known >5 minutes, or unsupported decode before model download.

Normalize decoded audio to mono Float32 16 kHz. Whisper chunks become client-generated UUID segments with integer timing, trimmed non-empty source text, >=100 ms duration, sorted/non-overlapping timing, <= canonical source duration, and <=500 segments. Empty/no-legal-segment output fails `LOCAL_ASR_EMPTY` and commits nothing.

All segments use the server-derived project-unique one-speaker id. The browser does not submit arbitrary speaker identity.

## Browser translation

Translate each normalized English segment locally to Vietnamese using the pinned Marian model. Translation is sequential in v1 to bound memory. Every segment must produce exactly one non-empty Vietnamese output; missing/duplicate/count-mismatched/empty output aborts the entire commit.

Translation provenance is always `browser-opus-mt`. Never label local work `workers-ai` or `google`.

## Atomic authenticated durable commit

Add exactly one inference-free authenticated route:

```text
PUT /api/projects/:id/client-inference/vi
```

Request carries:
- `expectedSourceGeneration`;
- `expectedSourceObjectKey`;
- `durationMs`;
- exact ASR provider/model/revision (`browser-whisper` + approved Whisper pin);
- 1..500 normalized segments;
- exact translation provider/model/revision (`browser-opus-mt` + approved Marian pin);
- one translation item for every segment.

Server rejects before mutation unless owner/project exists, source language is `en`, `vi` is enabled, source identity/generation exactly match, canonical size is known and <=24 MiB, duration is valid and within 1000 ms of existing canonical duration when present, model/provider/revisions exactly match constants, segment/translation sets are legal, request <=2 MiB, project is not `processing`, vi target is not `translating`/`exporting`, and no project export is `pending`/`exporting`.

Source identity/generation mismatch returns `409 LOCAL_INFERENCE_SOURCE_CONFLICT` with safe current canonical source metadata. Browser discards computed artifacts and requires a fresh local run.

All durable writes execute as one ordered D1 `db.batch()` after read-side validation:
1. invalidate prior current vi exports;
2. replace project source segments;
3. upsert exactly one speaker `browser-local:<projectId>:speaker-1`;
4. create completed vi translation variants;
5. mirror Vietnamese text/status/provenance into legacy segment columns required by existing readers;
6. persist truthful `browser-opus-mt` provenance;
7. leave voice pending and dubbed object null;
8. set canonical duration only when previously absent, otherwise retain canonical duration within tolerance;
9. set project and vi target status to `needs_review`;
10. preserve current source generation/object key.

If atomic `db.batch()` is unavailable/fails, fail closed; do not emulate atomicity with sequential writes.

## Schema evolution

The original `segments.translation_engine` CHECK excludes `browser-opus-mt`, while modern `segment_translations.translation_engine` accepts text. Because local provenance must be truthful in legacy mirrors, a new append-only migration is required if that CHECK still exists on latest `main`.

Rules:
- re-fetch latest `main` and migrations immediately before allocating the next filename;
- use `0013_browser_local_translation_engine.sql` only if `0013` is still unused;
- never edit, rename, or renumber deployed migrations;
- preserve all current segment rows/columns/indexes/FKs/split lineage while widening only the required engine admission;
- keep historical Stream migration lineage untouched;
- keep readiness `schemaRevision=14` unless a separately justified readiness capability change is introduced; it is not a migration counter.

## Studio orchestration and resumability

Expose an explicit action such as `Process locally (zero-cost)` for eligible EN→VI cloud projects. Do not silently replace normal paid-provider actions.

Phases:
- Preparing source
- Downloading ASR model
- Transcribing locally
- Downloading translation model
- Translating locally
- Saving transcript
- Preparing Vietnamese voices
- Exporting

After atomic commit, refetch canonical vi variants and reuse existing browser Piper exact-version preload/upload, then reuse the existing modern vi dubbed export. Piper starts only from canonical server truth.

Resume is artifact-driven: current-generation completed local translations skip ASR/translation; exact-version PCM skips synthesis; current completed export may be reused; source generation changes invalidate prior local inference.

Local failure offers local retry only. It never routes to `/process`, retranslate, remote TTS, or another provider.

## Verification / #91

Source and CI gates must prove exact package/model pins, worker-only model imports, local network denylist, source race guards, bounded limits, atomic persistence, truthful provenance, migration-chain integrity, Piper handoff, and exact-head full CI/current-main mergeability.

After merge/deploy, #91 remains OPEN until a real authorized browser production fixture proves:
1. schema-14 R2/remux readiness;
2. authorized H.264/AAC upload;
3. no Stream/Container/getByName regression;
4. no metered ASR/translation/TTS request;
5. exact pinned local Whisper transcript + one durable project-unique speaker;
6. exact pinned local EN→VI completed variants with `browser-opus-mt`;
7. browser Piper exact-version PCM;
8. UI-triggered modern dubbed export;
9. reload preserves durable artifacts/export identity;
10. final private-R2 MP4 is H.264 + AAC;
11. output H.264 elementary-stream SHA equals source;
12. frontend build SHA, backend version, gateway version, model IDs/revisions and project/job/export IDs are recorded.

Only terminal real-media evidence closes #91. Only after #91 PASS may #128 be refreshed/revalidated for merge.

## Spec self-review

The approved spec has no TODO/TBD placeholders. Model/revision pins, the `PUT /api/projects/:id/client-inference/vi` contract, v1 limits, project-unique speaker identity, atomic D1 boundary, append-only migration rule, and hard zero-cost denylist are consistent with the replacement implementation plan. The superseded backend prepared-ASR path is explicitly excluded from the final architecture.
