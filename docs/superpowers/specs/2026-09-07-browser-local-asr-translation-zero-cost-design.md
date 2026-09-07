# Zero-Cost Browser-Local ASR + EN→VI Translation Design

Date: 2026-09-07
Status: Approved architecture; written-spec review required before implementation
Base: `main` at `fc66c4e9b39d9cbb47edcaf8eb115f163ab8e269`
Issue: #91
Paid-Resources: FORBIDDEN

## 1. Goal

Remove the remaining metered inference dependency from the zero-cost production qualification path by running both speech recognition and English-to-Vietnamese translation in the user's browser. The qualified path becomes:

`private R2 source → browser decode → browser Whisper ASR → browser EN→VI translation → atomic durable commit → existing browser Piper PCM → existing R2 dubbed export/remux`

The lane must be genuinely fail-closed. If local model loading, browser compute, media decode, transcript generation, translation, durable commit, Piper preload, or export fails, the UI reports the local error and does not fall back to Workers AI, Deepgram, Google Translate, Grok, ElevenLabs, Sync Labs, Stream, Containers, or any other metered provider/resource.

This design changes the zero-cost qualification path only. Existing remote provider paths remain available to the normal product under their existing explicit paid-provider policy; they are not silently removed or selected by this local lane.

## 2. Why this change is required

The production backend account is a Workers Paid/Standard account. Workers AI includes a free daily allocation but usage beyond that allocation can be billable, and the current connector cannot prove a hard account-level no-overage boundary at dispatch time. Therefore the current `zero_charge_verified` gate cannot safely be set to true.

Browser Piper already removed paid Vietnamese TTS from the qualification path. The remaining metered inference steps are server-side ASR and translation. The only way to satisfy the operator's absolute no-paid-services rule without a separate hard-capped Workers Free account is to remove those server inference calls from the qualification path.

## 3. Supported v1 scope

The first local-inference lane is deliberately narrow:

- source language: English (`en`) only;
- target language: Vietnamese (`vi`) only;
- source media: the existing small/private H.264 + AAC production qualification fixture and equivalent browser-decodable uploads;
- source duration: maximum 5 minutes;
- source size: maximum 24 MiB;
- speaker model: exactly one durable speaker for v1;
- ASR: browser-local Whisper;
- translation: browser-local Marian EN→VI;
- voice: existing browser Piper exact-version PCM path;
- export: existing modern `vi` dubbed export and R2 packet-copy remux path.

General multi-speaker diarization, arbitrary source languages, long-form local ASR, offline-first model mirroring to R2, and replacing the normal remote product pipeline are non-goals for this carrier.

The one-speaker limitation is explicit rather than simulated diarization. The deterministic qualification fixture contains one speaker, so #91 can prove durable segments plus a durable speaker without claiming general diarization support.

## 4. Pinned browser ML stack

Add exact dependency:

- `@huggingface/transformers`: `4.2.0`

Reuse the repo's existing `onnxruntime-web` pin unless Transformers.js 4.2.0 dependency resolution proves it requires a different compatible version during TDD. Any ORT change must be exact-pinned and separately reviewed; no caret range is introduced for browser inference.

Pinned models:

### ASR

- model: `onnx-community/whisper-tiny.en`
- revision: `2575352d61be1bf7225cf8f8b268a4678025fc58`
- task: `automatic-speech-recognition`
- preferred dtype: `q8`
- preferred device: `webgpu`
- fallback device: `wasm`

Hugging Face's Transformers.js documentation uses this model for browser WebGPU Whisper ASR and supports immutable `revision` pinning. The model repository is explicitly published for Transformers.js with ONNX weights.

### Translation

- model: `Xenova/opus-mt-en-vi`
- revision: `3f5f449333cbc7ecaa9eec16ee9e37682f036b8e`
- task: `translation`
- preferred dtype: `q8`
- preferred device: `webgpu` when the model/device combination initializes successfully;
- fallback device: `wasm`.

The model is the ONNX/Transformers.js conversion of Helsinki-NLP `opus-mt-en-vi` and directly supports English-to-Vietnamese translation.

Model files are downloaded from Hugging Face Hub, not sent to an inference endpoint. Transformers.js browser cache is enabled so repeated runs reuse model/WASM artifacts. Model download is network transfer only; media, transcript text, and translated text are never sent to Hugging Face inference services.

If the pinned revision cannot be downloaded, cannot initialize, or cannot run locally, the lane fails closed. It must not change to `main`, another model, or a remote provider automatically.

## 5. Browser worker architecture

Use isolated module workers rather than running inference on the React main thread.

### 5.1 `browserAsr.worker.ts`

Responsibilities:

- lazy-import `@huggingface/transformers`;
- initialize the pinned Whisper pipeline;
- choose WebGPU first and retry initialization once with WASM only when WebGPU initialization is unsupported/fails before inference;
- accept mono Float32 PCM at 16 kHz;
- run ASR with timestamp chunks;
- return normalized local transcript chunks;
- expose progress/model-download events;
- expose structured error codes;
- dispose the pipeline on explicit shutdown.

It must never call DubFlow `/process`, Workers AI, Deepgram, or any provider endpoint.

### 5.2 `browserTranslation.worker.ts`

Responsibilities:

- lazy-import `@huggingface/transformers`;
- initialize the pinned `opus-mt-en-vi` pipeline;
- translate canonical local transcript strings sequentially;
- expose progress/model-download events;
- return translated text keyed by local segment ID;
- expose structured error codes;
- dispose the pipeline on explicit shutdown.

It must never call DubFlow server translation routes or Google/Workers AI provider endpoints.

### 5.3 Memory lifecycle

Do not keep Whisper, Marian, and Piper models resident simultaneously when avoidable.

The coordinator lifecycle is:

1. decode source;
2. initialize/run Whisper;
3. dispose ASR worker after transcript is materialized;
4. initialize/run translation worker;
5. dispose translation worker after translations are materialized;
6. atomically commit durable local inference;
7. invoke existing Piper preload, which owns its existing worker/session lifecycle.

Browser model artifacts remain in browser cache even when worker sessions are disposed.

## 6. Source audio acquisition and decode

The browser uses the existing authenticated/signed private-R2 source media path already used by Studio. No public source bucket and no new debug endpoint are introduced.

Before local inference, the coordinator fetches current canonical project metadata and captures:

- `sourceObjectKey`;
- `sourceGeneration`;
- `sizeBytes`;
- `durationMs` when already known.

Admission fails before model work if:

- source language is not `en`;
- target `vi` is not enabled;
- source object is missing;
- source exceeds 24 MiB;
- known duration exceeds 5 minutes;
- browser media decoding is unsupported.

For v1, browser decode may use the browser's supported media/audio decode path for the qualification H.264/AAC MP4. The decoded stream is normalized to mono Float32 16 kHz for Whisper. This carrier does not add FFmpeg, Containers, or server-side transcoding for local ASR.

If duration was unknown before decode, the browser-computed duration is included in the atomic commit. The server validates it as a positive bounded integer and rejects it if it conflicts materially with an already persisted canonical duration.

## 7. Local transcript normalization

Whisper timestamp chunks are converted into `PersistedAsrSegment`-compatible records:

- client-generated UUID `id`;
- `startMs` and `endMs` rounded to integers;
- trimmed non-empty `sourceText`;
- fixed speaker ID `browser-local-speaker-1`;
- sorted by start time;
- no overlap;
- minimum segment duration follows existing `MIN_SEGMENT_MS` rules;
- end time must not exceed canonical/bounded source duration.

Empty chunks are dropped. A run that produces no legal segment fails with `LOCAL_ASR_EMPTY` and commits nothing.

The browser does not claim diarization. All v1 chunks belong to the same speaker.

## 8. Translation behavior

Each normalized English source segment is translated locally to Vietnamese using the pinned Marian model. Translation is sequential in v1 to bound memory and simplify progress/retry behavior.

A translation is accepted locally only when it is a non-empty string after trim. If any segment translation fails or is empty, the entire local-inference commit is withheld. There is no partially translated durable state from this initial commit.

The local translation map is keyed by the exact client segment IDs generated during ASR.

## 9. Atomic authenticated durable commit

Add one authenticated route:

`PUT /api/projects/:id/client-inference/vi`

The route does no inference. It only validates and persists browser-computed results.

### 9.1 Request shape

```json
{
  "expectedSourceGeneration": 3,
  "expectedSourceObjectKey": "projects/<id>/source/<file>.mp4",
  "durationMs": 12000,
  "asr": {
    "provider": "browser-whisper",
    "model": "onnx-community/whisper-tiny.en",
    "revision": "2575352d61be1bf7225cf8f8b268a4678025fc58",
    "segments": [
      {
        "id": "<uuid>",
        "startMs": 0,
        "endMs": 2400,
        "sourceText": "Hello world"
      }
    ]
  },
  "translation": {
    "provider": "browser-opus-mt",
    "model": "Xenova/opus-mt-en-vi",
    "revision": "3f5f449333cbc7ecaa9eec16ee9e37682f036b8e",
    "items": [
      {
        "segmentId": "<same uuid>",
        "translatedText": "Xin chào thế giới"
      }
    ]
  }
}
```

### 9.2 Server validation

The server must fail before mutation unless all conditions hold:

- authenticated project owner exists;
- project source language is `en`;
- target language is exactly `vi` and enabled;
- canonical `sourceGeneration` equals `expectedSourceGeneration`;
- canonical `sourceObjectKey` exactly equals `expectedSourceObjectKey`;
- source size is present and <= 24 MiB;
- duration is > 0 and <= 5 minutes;
- if canonical duration exists, submitted duration is within a small deterministic tolerance; otherwise it may become the canonical project duration;
- ASR provider/model/revision exactly match the hard-coded local lane constants;
- translation provider/model/revision exactly match the hard-coded local lane constants;
- segment IDs are unique;
- segments normalize through existing segment domain rules, are ordered/non-overlapping, and stay inside duration;
- every segment has exactly one translation item and no translation exists for an unknown segment;
- translated text is non-empty and bounded;
- project is not currently in server-side `processing`/exporting mutation state.

Source-generation or source-object mismatch returns `409 LOCAL_INFERENCE_SOURCE_CONFLICT` with current canonical project source metadata. The client must discard computed results and require a fresh local run; it must not attach stale transcript/translation to a replaced upload.

### 9.3 Atomic persistence

Use D1 batch/transactional semantics. The commit must atomically:

1. invalidate/clear prior project exports;
2. replace the project's source segments;
3. create/upsert one speaker:
   - id: `browser-local-speaker-1` scoped to the project;
   - label: `Browser local`;
   - display name: a neutral one-speaker label;
4. create completed `vi` translation variants for every segment;
5. mirror Vietnamese translated text/status into legacy segment columns needed by existing code;
6. set translation provenance to `browser-opus-mt` instead of falsely labeling it `workers-ai`/`google`;
7. keep voice status pending with no dubbed object until Piper upload;
8. set project duration if previously unknown;
9. leave project in the existing review/export-ready state used by Studio (`needs_review` unless a more precise existing state is required by tests).

No schema migration is required for v1 because existing engine/provider fields are strings. Repository TypeScript unions that currently restrict writes to `workers-ai | google` must be widened narrowly to include `browser-opus-mt`; existing remote behavior is unchanged.

The route returns canonical segments, canonical `vi` translation variants, project source generation, and model provenance so the client can start Piper from server truth rather than local assumptions.

## 10. Reuse existing Piper/export path

After the atomic local-inference commit succeeds:

1. refetch canonical `vi` variants;
2. call the existing browser Piper preload coordinator;
3. Piper uploads exact-version PCM through the already merged `voice-pcm` endpoint;
4. refetch to prove every current translation version has completed PCM;
5. invoke the existing modern `/exports/vi` dubbed export;
6. preserve existing reload/durability, H.264/AAC, and H.264 packet-preservation checks.

No server voice provider is consulted for this local lane.

## 11. Studio UX and resumability

Expose one explicit zero-cost action for eligible English→Vietnamese projects, e.g. `Process locally (zero-cost)`.

Progress phases:

- Preparing source
- Downloading ASR model
- Transcribing locally
- Downloading translation model
- Translating locally
- Saving transcript
- Preparing Vietnamese voices
- Exporting

Progress inside a local model stage is ephemeral, but completed artifacts are durable. Reload behavior is artifact-driven:

- if canonical segments + completed `vi` translations already exist for the current source generation, skip ASR/translation;
- if exact-version PCM exists, skip Piper synthesis;
- if a completed current export exists, reuse it;
- if source generation changes, all prior local inference is stale and cannot be reused.

A browser/model failure never flips to a remote provider. The UI explains that local processing could not continue and offers retry of the local lane.

## 12. Network and zero-cost safety contract

During local ASR/translation the browser may contact only:

- DubFlow public gateway/API for authenticated project/source/persistence operations;
- the already configured signed source-media URL under the DubFlow gateway;
- Hugging Face Hub/CDN for pinned model files/WASM dependencies required by Transformers.js.

The local-inference orchestration must not call:

- `/api/projects/:id/process`;
- server translation `.../translations/.../process` or `.../retranslate`;
- `/api/voice/capabilities` for admission;
- Cloudflare Workers AI inference endpoints;
- AI Gateway;
- Deepgram;
- Google Translate;
- Grok/xAI;
- ElevenLabs;
- Sync Labs;
- Stream;
- Containers.

Source-contract tests and the production browser fixture will enforce this denylist.

The lane therefore does not depend on Cloudflare Workers AI free-headroom or billing state. `zero_charge_verified` must no longer be an operator assertion for this specific local fixture; instead, qualification eligibility is derived from the source/network contract proving no metered inference call is reachable from the fixture path.

## 13. Production qualification changes

After the local lane is implemented, merged, deployed, and exact-SHA CI/Workers Builds are green, update #91 acceptance transparently.

Acceptance item 4 for the zero-cost qualification becomes:

> Browser-local Whisper ASR completes without a remote inference provider, and durable canonical segments plus the one-speaker v1 identity are persisted for the current source generation. Browser-local EN→VI translation then persists completed durable `vi` variants with browser-local provenance.

This replaces the old `Remote ASR completes` wording only for the zero-cost qualification path. It is not recorded as PASS until the real production fixture proves it.

The updated production fixture must prove:

1. schema-14 R2/remux readiness;
2. authorized H.264/AAC upload;
3. no Stream/Container/getByName regressions;
4. no metered ASR/translation/TTS calls;
5. browser Whisper transcript and one durable speaker;
6. browser EN→VI durable variants;
7. browser Piper exact-version PCM;
8. UI-triggered modern dubbed export;
9. reload preserves canonical artifacts/export identity;
10. final private-R2 MP4 is H.264 + AAC;
11. H.264 elementary stream SHA equals source (packet preservation);
12. model IDs, immutable revisions, frontend build SHA, backend version, and gateway version are recorded.

Only then may #91 be closed/qualified and PR #128 be reconsidered for merge after its own fresh main reconciliation/CI.

## 14. Error model

Use structured local errors, including at minimum:

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
- `LOCAL_INFERENCE_COMMIT_FAILED`

Browser worker errors are sanitized before UI display. Server errors never return secrets, signed source tokens, model cache internals, or raw provider credentials.

## 15. TDD / verification strategy

Implementation must proceed RED→GREEN in bounded steps.

### Source-contract RED

Add a top-level source acceptance test that initially fails because the dependency, workers, atomic route, and Studio orchestration do not exist. It must lock:

- exact `@huggingface/transformers` version;
- exact model IDs/revisions;
- worker-only imports;
- no `/process` or server translation calls in the local coordinator;
- atomic route source-generation guard;
- fixed one-speaker provenance;
- existing Piper/export reuse;
- production fixture denylist for metered providers.

### Unit tests

- Whisper worker protocol and device fallback;
- timestamp/segment normalization;
- local translation worker protocol;
- empty translation fail-closed;
- source-generation/object-key conflict;
- duration/size bounds;
- atomic D1 replacement/idempotent retry behavior;
- local provenance (`browser-whisper`, `browser-opus-mt`);
- no partial commit when any item invalid;
- Studio artifact-resume behavior;
- no remote provider fallback;
- browser model cache/progress handling at adapter boundaries.

### Integration/CI

- full `npm run verify`;
- checked-in Wrangler dry-run;
- generated production Wrangler dry-run;
- existing screenshot/artifact gates;
- exact-head fresh PR CI after any main reconciliation;
- post-merge exact-main CI.

### Live qualification

Do not dispatch until the local lane is deployed and the browser fixture's network contract proves no metered inference path. Then run one authorized manual fixture and close #91 only from terminal real-media evidence.

## 16. Security and privacy

- Raw source media remains private and is accessed through the existing authenticated/signed R2 path.
- Source audio and transcript are processed locally; no raw audio/transcript is uploaded to Hugging Face inference because no HF inference API is used.
- Only final browser-computed transcript/translation artifacts are committed to DubFlow through the authenticated project route.
- Commit is bound to exact source generation/object key to prevent stale attachment after re-upload.
- Existing user/project authorization remains mandatory.
- No secret or paid-provider setting is changed by this feature.

## 17. Non-goals

This carrier does not:

- implement multi-speaker diarization;
- support local ASR for non-English source languages;
- support local translation targets other than Vietnamese;
- remove the existing remote ASR/translation providers from the product;
- change billing/account settings;
- add a Cloudflare Worker AI spend meter;
- mirror Hugging Face models into R2;
- add Containers, Stream, FFmpeg runtime, or server GPU compute;
- close #91 from source/CI success;
- merge #128 before a real production E2E PASS.

## 18. External references verified on 2026-09-07

- Transformers.js WebGPU guide: https://huggingface.co/docs/transformers.js/guides/webgpu
- Transformers.js pipeline/revision documentation: https://huggingface.co/docs/transformers.js/pipelines
- Transformers.js browser cache/env documentation: https://huggingface.co/docs/transformers.js/api/env
- npm `@huggingface/transformers` 4.2.0: https://www.npmjs.com/package/@huggingface/transformers
- Whisper model: https://huggingface.co/onnx-community/whisper-tiny.en
- Whisper pinned revision: https://huggingface.co/onnx-community/whisper-tiny.en/commit/2575352d61be1bf7225cf8f8b268a4678025fc58
- EN→VI model: https://huggingface.co/Xenova/opus-mt-en-vi
- EN→VI pinned revision: https://huggingface.co/Xenova/opus-mt-en-vi/tree/3f5f449333cbc7ecaa9eec16ee9e37682f036b8e
