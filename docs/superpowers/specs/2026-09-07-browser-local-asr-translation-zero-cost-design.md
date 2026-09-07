# Zero-Cost Browser-Local ASR + EN→VI Translation Design

Date: 2026-09-07
Status: Written-spec review required before implementation
Base: `main` at `fc66c4e9b39d9cbb47edcaf8eb115f163ab8e269`
Issue: #91
Paid-Resources: FORBIDDEN

## 1. Goal

Remove the remaining metered inference dependency from the zero-cost production qualification path by running speech recognition and English-to-Vietnamese translation in the user's browser.

Qualified zero-cost path:

`private R2 source → browser decode → browser Whisper ASR → browser EN→VI translation → atomic durable commit → existing browser Piper PCM → existing R2 dubbed export/remux`

The lane is fail-closed. Local model, decode, ASR, translation, persistence, Piper, or export failure must surface a local error and must never fall back to Workers AI, Deepgram, Google Translate, Grok/xAI, ElevenLabs, Sync Labs, Stream, Containers, or another metered provider/resource.

Existing remote provider paths remain available to the normal product under their existing explicit paid-provider policy. This lane does not silently select or remove them.

## 2. Why this change is required

The production backend account is Workers Paid/Standard. Workers AI has a daily free allocation, but usage above that allocation can be billed and the current account surface cannot prove a hard no-overage boundary at dispatch time. Therefore `zero_charge_verified=true` cannot safely be asserted for a fixture that calls Workers AI.

Browser Piper already removed paid Vietnamese TTS from the zero-cost path. The remaining metered steps are server ASR and translation, so this design removes those calls from the qualification path entirely.

## 3. v1 scope

The first local lane is intentionally narrow:

- source language: English (`en`) only;
- target language: Vietnamese (`vi`) only;
- source media: existing browser-decodable H.264/AAC MP4 flow;
- maximum source duration: 5 minutes;
- maximum source size: 24 MiB;
- maximum persisted ASR segments: 500;
- speaker model: exactly one durable speaker;
- ASR: browser-local Whisper;
- translation: browser-local Marian EN→VI;
- voice: existing browser Piper exact-version PCM;
- export: existing modern `vi` dubbed export and R2 packet-copy remux.

Non-goals: multi-speaker diarization, arbitrary source languages, long-form local ASR, local targets other than Vietnamese, replacing normal remote pipelines, model mirroring to R2, Containers, Stream, or server GPU inference.

The one-speaker limitation is explicit. The qualification fixture has one speaker, so #91 may prove durable segments plus one durable speaker without claiming diarization support.

## 4. Pinned browser ML stack

Add exact dependency:

- `@huggingface/transformers`: `4.2.0`

Reuse the existing exact `onnxruntime-web` pin unless TDD proves Transformers.js requires a different compatible version. Any ORT change must remain exact-pinned and separately reviewed.

### ASR

- task: `automatic-speech-recognition`
- model: `onnx-community/whisper-tiny.en`
- revision: `2575352d61be1bf7225cf8f8b268a4678025fc58`
- dtype: `q8`
- preferred device: WebGPU
- fallback: WASM only when WebGPU initialization fails before inference

### Translation

- task: `translation`
- model: `Xenova/opus-mt-en-vi`
- revision: `3f5f449333cbc7ecaa9eec16ee9e37682f036b8e`
- dtype: `q8`
- preferred device: WebGPU when initialization succeeds
- fallback: WASM

Model files come from Hugging Face Hub/CDN and are executed locally through Transformers.js. No Hugging Face inference API is used. Media, transcript text, and translated text are never sent to Hugging Face inference services.

Transformers.js browser cache is enabled. If an exact pinned revision cannot download, initialize, or execute locally, the lane fails closed; it must not switch to another revision/model/provider automatically.

## 5. Browser worker architecture

Use isolated module workers; do not run model inference on the React main thread.

### 5.1 ASR worker

`browserAsr.worker.ts`:

- lazy-imports `@huggingface/transformers`;
- initializes exact Whisper model/revision;
- consumes mono Float32 PCM at 16 kHz;
- returns timestamped transcript chunks;
- exposes model/progress events and structured errors;
- disposes on explicit shutdown;
- never calls `/process`, Workers AI, Deepgram, or another provider endpoint.

### 5.2 Translation worker

`browserTranslation.worker.ts`:

- lazy-imports `@huggingface/transformers`;
- initializes exact EN→VI model/revision;
- translates normalized segment strings sequentially;
- returns translated text keyed by local segment ID;
- exposes model/progress events and structured errors;
- disposes on explicit shutdown;
- never calls server translation routes or Google/Workers AI provider endpoints.

### 5.3 Memory lifecycle

Avoid keeping Whisper, Marian, and Piper resident together:

1. fetch/decode source;
2. initialize/run Whisper;
3. dispose ASR worker after transcript materializes;
4. initialize/run translation worker;
5. dispose translation worker after translations materialize;
6. atomically commit durable local inference;
7. invoke existing Piper preload.

Cached model files may remain in browser cache after worker disposal.

## 6. Source acquisition and decode

Use the existing authenticated/signed private-R2 source-media path already consumed by Studio. Do not expose the bucket publicly and do not add a debug source endpoint.

Before local inference capture canonical:

- `sourceObjectKey`;
- `sourceGeneration`;
- `sizeBytes`;
- `durationMs` when known.

Fail before model work when:

- source language is not `en`;
- target `vi` is not enabled;
- source object is missing;
- source exceeds 24 MiB;
- known duration exceeds 300,000 ms;
- browser media decode is unsupported.

For v1, use the browser-supported decode path for the H.264/AAC MP4 fixture and normalize decoded audio to mono Float32 16 kHz for Whisper. No FFmpeg/Container/server transcode is introduced.

If canonical duration is absent, browser-computed duration is submitted. If canonical duration exists, submitted duration must differ by no more than **1,000 ms absolute**; otherwise the server rejects the commit as invalid. All durations remain <= 300,000 ms.

## 7. Local transcript normalization

Convert Whisper chunks into existing `PersistedAsrSegment` shape:

- client-generated UUID segment ID;
- integer `startMs`/`endMs`;
- trimmed non-empty `sourceText`;
- one deterministic project-unique speaker ID: `browser-local:<projectId>:speaker-1`;
- sorted by start time;
- no overlap;
- existing `MIN_SEGMENT_MS = 100` minimum;
- end time cannot exceed bounded source duration;
- maximum 500 segments.

The speakers table uses a global `id` primary key, so a repository-global literal such as `browser-local-speaker-1` is forbidden.

Empty chunks are dropped. If no legal segment remains, fail with `LOCAL_ASR_EMPTY` and persist nothing.

## 8. Translation behavior

Translate each normalized English segment locally to Vietnamese, sequentially in v1. Every segment must produce one non-empty translated string.

The initial durable commit is all-or-nothing: if any translation fails or is empty, persist neither transcript nor translations.

Each translation is keyed by the exact generated segment ID. The request body is capped at **2 MiB** and at **500 segments** to bound validation/mutation work.

## 9. Atomic authenticated durable commit

Add one authenticated route:

`PUT /api/projects/:id/client-inference/vi`

The route performs no inference; it only validates and persists browser-computed artifacts.

### 9.1 Request

```json
{
  "expectedSourceGeneration": 3,
  "expectedSourceObjectKey": "projects/<id>/source/<file>.mp4",
  "durationMs": 12000,
  "asr": {
    "provider": "browser-whisper",
    "model": "onnx-community/whisper-tiny.en",
    "revision": "2575352d61be1bf7225cf8f8b268a4678025fc58",
    "segments": [{
      "id": "<uuid>",
      "startMs": 0,
      "endMs": 2400,
      "sourceText": "Hello world"
    }]
  },
  "translation": {
    "provider": "browser-opus-mt",
    "model": "Xenova/opus-mt-en-vi",
    "revision": "3f5f449333cbc7ecaa9eec16ee9e37682f036b8e",
    "items": [{
      "segmentId": "<same uuid>",
      "translatedText": "Xin chào thế giới"
    }]
  }
}
```

### 9.2 Validation

Fail before mutation unless all are true:

- authenticated owner/project exists;
- source language is `en`;
- `vi` is enabled;
- source generation and object key exactly match canonical values;
- canonical size exists and is <= 24 MiB;
- duration is a positive integer <= 300,000 ms;
- canonical duration, when present, is within 1,000 ms of submitted duration;
- model/provider/revision exactly match hard-coded local constants;
- 1..500 unique segment IDs;
- segment normalization passes existing domain rules;
- segments are ordered, non-overlapping, and inside duration;
- translation items form an exact one-to-one set with segment IDs;
- every translated text is non-empty;
- request body is <= 2 MiB;
- `projects.status !== 'processing'`;
- `project_target_languages.status` for `vi` is neither `translating` nor `exporting`;
- no current `project_exports` row for the project is `pending` or `exporting`.

Source-generation/object-key mismatch returns `409 LOCAL_INFERENCE_SOURCE_CONFLICT` with current canonical source metadata. The client discards computed artifacts and requires a fresh local run.

### 9.3 Persistence

Add a dedicated repository method for client inference; do not contort the remote ASR path into pretending the provider is Workers AI.

Execute the durable replacement as one ordered D1 `db.batch()` mutation. Tests must prove the route does not expose a partial durable state when validation or a batch statement fails.

The batch must:

1. invalidate prior current exports;
2. replace source segments;
3. upsert exactly one project-unique speaker:
   - id `browser-local:<projectId>:speaker-1`;
   - label `Browser local`;
   - neutral display name;
4. create completed `vi` translation variants for every segment;
5. mirror translated text/status/provenance into legacy segment columns required by existing readers;
6. persist translation provenance `browser-opus-mt` rather than falsely labeling local translation as Workers AI/Google;
7. leave voice status pending and dubbed object null until Piper upload;
8. set canonical duration when previously absent;
9. set project and `vi` target status to `needs_review`;
10. preserve current source generation/object key.

### 9.4 Schema migration

A schema migration **is required**. The original `segments.translation_engine` column has a CHECK constraint limited to legacy values, while modern `segment_translations.translation_engine` is unconstrained text. Because this design mirrors truthful provenance to legacy segment columns, `browser-opus-mt` must be admitted by the legacy CHECK constraint.

Implementation must add a new **append-only** migration that widens only the required `segments.translation_engine` constraint while preserving every existing row/value/index/foreign-key behavior.

Rules:

- never rename, edit, or renumber any migration already deployed;
- re-fetch current `main` at implementation time and allocate the next unused migration filename then;
- add full migration-chain regression coverage;
- keep historical Stream migration lineage untouched.

TypeScript provider unions are widened narrowly to include `browser-opus-mt`.

### 9.5 Response

Return canonical:

- project source generation/object key/duration;
- persisted segments/speaker;
- completed `vi` translation variants;
- browser ASR/translation model provenance.

Piper must start from this server response/refetch, never from uncommitted local assumptions.

## 10. Reuse Piper/export path

After commit:

1. refetch canonical `vi` variants;
2. run existing browser Piper preload;
3. upload exact-version PCM through existing `voice-pcm` route;
4. refetch and prove all current versions have completed PCM;
5. invoke existing modern `/exports/vi` dubbed export;
6. preserve reload/durability, H.264/AAC, and exact H.264 packet-preservation gates.

No server voice provider is consulted for this local lane.

## 11. Studio UX and resumability

Expose an explicit action such as **Process locally (zero-cost)** for eligible EN→VI projects.

Progress phases:

- Preparing source
- Downloading ASR model
- Transcribing locally
- Downloading translation model
- Translating locally
- Saving transcript
- Preparing Vietnamese voices
- Exporting

Resume from durable artifacts:

- current-generation canonical segments + completed `vi` translations → skip ASR/translation;
- exact-version PCM → skip Piper;
- current completed export → reuse export;
- source generation change → all earlier local inference is stale.

Browser/model failure remains local-only and offers local retry. It never changes provider automatically.

## 12. Zero-cost network contract

During local inference, browser requests may go only to:

- DubFlow gateway/API for authenticated source/persistence/export operations;
- DubFlow signed source-media URL;
- Hugging Face Hub/CDN for exact pinned model/WASM files.

The local orchestration must not call:

- `/api/projects/:id/process`;
- server translation process/retranslate routes;
- `/api/voice/capabilities` for admission;
- Workers AI inference;
- AI Gateway;
- Deepgram;
- Google Translate;
- Grok/xAI;
- ElevenLabs;
- Sync Labs;
- Stream;
- Containers.

Source-contract tests and the production browser fixture enforce this denylist.

For this local fixture, qualification eligibility is derived from the reachable-network contract rather than an operator guess about Workers AI quota. The fixture must not set `zero_charge_verified=true` merely to bypass the current guard; implementation must replace that assertion with an explicit **local-inference-only** mode whose source contract proves metered inference is unreachable.

## 13. Production qualification / #91

After implementation is merged/deployed and exact-SHA CI plus Workers Builds are green, update #91 transparently. The zero-cost acceptance replaces old remote-ASR wording with:

> Browser-local Whisper ASR completes without a remote inference provider, and durable canonical segments plus the v1 one-speaker identity are persisted for the current source generation. Browser-local EN→VI translation persists completed durable `vi` variants with browser-local provenance.

This change applies only to the zero-cost qualification lane and is not marked PASS until a real production fixture proves it.

The production fixture must prove:

1. schema-14 R2/remux readiness;
2. authorized H.264/AAC upload;
3. no Stream/Container/getByName regression;
4. no metered ASR/translation/TTS request;
5. browser Whisper transcript + one durable speaker;
6. browser EN→VI completed durable variants;
7. browser Piper exact-version PCM;
8. UI-triggered modern dubbed export;
9. reload preserves canonical artifacts/export identity;
10. private-R2 final MP4 is H.264 + AAC;
11. output H.264 elementary-stream SHA equals source;
12. model IDs/revisions plus frontend build SHA, backend version, and gateway version are recorded.

Only terminal real-media evidence can close #91. Only after #91 PASS may PR #128 be refreshed/revalidated and considered for merge.

## 14. Error model

At minimum:

- `LOCAL_INFERENCE_UNSUPPORTED`
- `LOCAL_SOURCE_TOO_LARGE`
- `LOCAL_SOURCE_TOO_LONG`
- `LOCAL_SOURCE_DECODE_FAILED`
- `LOCAL_ASR_INIT_FAILED`
- `LOCAL_ASR_FAILED`
- `LOCAL_ASR_EMPTY`
- `LOCAL_TRANSLATION_INIT_FAILED`
- `LOCAL_TRANSLATION_FAILED`
- `LOCAL_INFERENCE_SOURCE_CONFLICT`
- `LOCAL_INFERENCE_INVALID`
- `LOCAL_INFERENCE_BUSY`
- `LOCAL_INFERENCE_COMMIT_FAILED`

Sanitize worker/server errors. Never expose secrets, signed source tokens, provider credentials, or model-cache internals.

## 15. TDD and verification

Implementation proceeds RED→GREEN in bounded steps.

### Source-contract RED

Lock initially missing contracts for:

- exact Transformers.js version;
- exact model IDs/revisions;
- worker-only model imports;
- no remote ASR/translation/TTS path in local coordinator;
- source generation/object-key guard;
- project-unique one-speaker identity;
- append-only migration and truthful provenance;
- existing Piper/export reuse;
- production-fixture metered-provider denylist.

### Unit/integration tests

Cover:

- WebGPU→WASM initialization fallback;
- timestamp/segment normalization and 100 ms minimum;
- 500-segment and 2 MiB limits;
- translation worker and empty-translation failure;
- source conflict and 1,000 ms duration tolerance;
- busy/export race rejection;
- D1 replacement/no partial durable state;
- project-unique speaker ID;
- `browser-opus-mt` provenance + migration chain;
- artifact-resume behavior;
- no remote provider fallback;
- model cache/progress adapter behavior.

### CI/integration gates

- full `npm run verify`;
- checked-in Wrangler dry-run;
- generated-production Wrangler dry-run;
- screenshots/artifact;
- exact-head fresh PR CI after any main reconciliation;
- post-merge exact-main CI.

Do not dispatch the live fixture until the merged local lane and fixture network denylist make metered inference unreachable.

## 16. Security and privacy

- raw source stays private via existing authenticated/signed R2 path;
- audio/transcript processing is local;
- Hugging Face is used only for static pinned model files, not inference;
- only final transcript/translation artifacts are committed to DubFlow;
- commit binds to exact source generation/object key;
- normal user/project authorization is mandatory;
- no paid-provider/billing setting changes.

## 17. Non-goals

This design does not:

- implement diarization;
- support non-English local ASR or non-Vietnamese local translation;
- remove existing remote providers from the normal product;
- change Cloudflare billing/account settings;
- add Worker AI spend metering;
- add Stream, Containers, FFmpeg runtime, or server GPU compute;
- mirror models to R2;
- close #91 from source/CI success;
- merge #128 before real E2E PASS.

## 18. External references verified 2026-09-07

- Transformers.js WebGPU: https://huggingface.co/docs/transformers.js/guides/webgpu
- Transformers.js pipelines/revision: https://huggingface.co/docs/transformers.js/pipelines
- Transformers.js cache/env: https://huggingface.co/docs/transformers.js/api/env
- npm `@huggingface/transformers` 4.2.0: https://www.npmjs.com/package/@huggingface/transformers
- Whisper model: https://huggingface.co/onnx-community/whisper-tiny.en
- Whisper revision: https://huggingface.co/onnx-community/whisper-tiny.en/commit/2575352d61be1bf7225cf8f8b268a4678025fc58
- EN→VI model: https://huggingface.co/Xenova/opus-mt-en-vi
- EN→VI revision: https://huggingface.co/Xenova/opus-mt-en-vi/tree/3f5f449333cbc7ecaa9eec16ee9e37682f036b8e
