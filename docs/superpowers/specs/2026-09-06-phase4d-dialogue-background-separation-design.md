# DubFlow Phase 4D — Dialogue / Background Separation Design

Date: 2026-09-06
Status: Approved direction; written for review

## 1. Goal

Add an optional, durable dialogue/background stem-separation stage to the dubbing/export pipeline so dubbed speech can replace source dialogue while preserving ambience/music more cleanly than the current full-source mix.

Phase 4D must not weaken the existing export path. If separation is unavailable or not requested, the current source-media + dubbed-clips render remains the fallback.

## 2. Scope

Phase 4D covers:

- a provider boundary for source stem separation;
- a first concrete ElevenLabs stem-separation provider using the already-supported `ELEVENLABS_API_KEY` secret;
- durable R2 object keys for dialogue/background stems;
- orchestration from export into separation only when requested and supported;
- FFmpeg-container render support for using the background stem as the base audio;
- idempotency, usage accounting, telemetry, retries and cancellation;
- API/UI capability reporting so the feature is exposed only when available;
- regression coverage that protects the existing export path.

Phase 4D does not add visual lip-sync. That is Phase 4E.

## 3. Design choice

Use a dedicated `StemSeparationProvider` interface rather than hard-coding provider details into export orchestration.

The first provider is ElevenLabs Stem Separation with `stem_variation_id=two_stems_v1`. The existing media container remains the heavy-media execution boundary: it extracts/normalizes source audio, streams it to a virtual outbound host, receives the provider ZIP, validates/unpacks the two stems, and writes immutable project-scoped R2 artifacts.

The container does not receive the ElevenLabs secret. `FfmpegContainer.outboundByHost` intercepts the virtual provider host in the trusted Worker runtime, rewrites the request to the official ElevenLabs stem-separation endpoint, injects `xi-api-key` from `env.ELEVENLABS_API_KEY`, and forwards the streaming body. This keeps the provider credential out of the container sandbox while allowing only the explicit outbound host.

The provider boundary keeps the rest of DubFlow independent from ElevenLabs, so a future hosted provider can replace it without changing export contracts.

## 4. Capability and fallback rules

Separation is opt-in per export.

Export modes:

- `source_mix` — current behavior; no stem separation required.
- `preserve_background` — requires `ELEVENLABS_API_KEY`, a healthy `FFMPEG_CONTAINER` binding and a completed background stem.

If `preserve_background` is requested but the provider/binding is unavailable, fail with a stable capability error before billable processing starts. Do not silently pretend separation happened.

If separation itself fails after admission, the export job fails with an actionable error and can be retried. The existing `source_mix` path remains available as a user-selectable fallback.

## 5. Storage contract

The current upload service creates immutable source keys in the form `projects/{projectId}/source/{uuid}.{extension}`. `sourceRevision` is therefore the source filename without its extension (the upload UUID); it must match `^[A-Za-z0-9_-]{1,100}$` after parsing.

Use immutable/versioned project-scoped keys:

- `projects/{projectId}/stems/{sourceRevision}/dialogue.wav`
- `projects/{projectId}/stems/{sourceRevision}/background.wav`

Reusing a completed stem pair for the same source revision is allowed and must avoid duplicate provider work and duplicate usage charges.

## 6. Domain contracts

Add:

```ts
export type SeparationMode = 'source_mix' | 'preserve_background';

export type StemSeparationResult = {
  dialogueObjectKey: string;
  backgroundObjectKey: string;
};

export interface StemSeparationProvider {
  readonly id: string;
  readonly available: boolean;
  separate(input: {
    projectId: string;
    sourceObjectKey: string;
    sourceRevision: string;
  }): Promise<StemSeparationResult>;
}
```

The concrete provider id is `elevenlabs-stems-v1`.

Media render options gain an optional `backgroundObjectKey`. The media layer validates that the key belongs to the same project and exact `stems/{sourceRevision}/` folder before calling the container.

## 7. Export flow

For dubbed exports:

1. authorize project and load job retry generation;
2. load source segments / target-language variants;
3. generate or reuse voice clips as today;
4. when `separationMode === 'preserve_background'`, derive `sourceRevision`, then load or create the durable stem pair;
5. record provider usage/telemetry idempotently;
6. call media render with dubbed clips and optional background stem;
7. publish export and complete the job.

Subtitle-only export never invokes stem separation.

## 8. Container responsibilities

The container API adds a separation endpoint and extends render input:

- `POST /separate-stems`
- `POST /render-export` accepts optional `backgroundObjectKey`

`/separate-stems` performs these exact steps:

1. fetch the project source object through the existing `media.r2` outbound handler;
2. use FFmpeg to normalize audio to a provider-supported file;
3. stream multipart audio to the virtual `elevenlabs.stems` host with `stem_variation_id=two_stems_v1`;
4. require a successful ZIP response;
5. unpack exactly two audio stems;
6. identify the speech/vocal stem and accompaniment/background stem by provider filenames, rejecting unknown/duplicate layouts;
7. normalize both to WAV with matched duration/sample format;
8. PUT both artifacts through `media.r2` to the canonical stem keys;
9. return only those canonical keys.

The render helper uses the background stem as the retained source-audio bed when present, then overlays duration-fitted dubbed clips. Without a background stem, current behavior is unchanged.

The Docker image adds only the archive utility required to inspect/unpack the provider ZIP; the Worker continues to avoid buffering large media files or invoking local FFmpeg.

## 9. Container outbound security

`FfmpegContainer` remains `enableInternet = false` and uses an allowlist.

Allowed virtual hosts:

- `media.r2`
- `elevenlabs.stems`

`elevenlabs.stems` is handled by `outboundByHost`; the trusted Worker handler rewrites the destination to `https://api.elevenlabs.io/v1/music/stem-separation`, preserves the streaming multipart body/query, injects `xi-api-key`, strips any caller-supplied authentication header, and forwards the response. The container never receives the secret value.

## 10. Error handling

Stable errors include:

- `STEM_SEPARATION_UNAVAILABLE`
- `STEM_SEPARATION_FAILED`
- `STEM_SEPARATION_RESPONSE_INVALID`
- `MEDIA_BACKGROUND_STEM_INVALID`
- `MEDIA_PROCESSOR_UNAVAILABLE`

The current raw JavaScript failure surface must never leak to users. Missing media/container capability becomes `MEDIA_PROCESSOR_UNAVAILABLE` rather than a `getByName` TypeError.

## 11. Usage and observability

Add one usage kind for separation runtime, measured in source audio seconds:

- `stem_separation_audio_second`

Provider id is `elevenlabs-stems-v1`. Use the existing started/completed operation-key pattern so retries do not double-charge completed work.

Telemetry emits provider start/success/failure with project/job/request correlation but never media/transcript content or provider credentials.

## 12. UI/API

Expose a capability object with at least:

```json
{
  "dialogueBackgroundSeparation": {
    "available": true,
    "provider": "elevenlabs-stems-v1",
    "modes": ["source_mix", "preserve_background"]
  }
}
```

Availability requires both a configured `ELEVENLABS_API_KEY` and the media-container binding. The export UI shows “Preserve background/music” only when capability is available. Otherwise it stays disabled with an explanatory reason; `source_mix` remains usable.

## 13. Testing

Required tests:

- provider contract and source-revision/object-key validation;
- outbound handler injects the secret server-side and strips caller auth;
- provider request uses `two_stems_v1` and rejects malformed ZIP/stem layouts;
- export pipeline does not invoke separation in `source_mix`;
- `preserve_background` reuses existing completed stems;
- failed provider does not mark export complete;
- retry/idempotency does not duplicate usage completion;
- render request carries the validated background stem;
- current legacy and multi-language export tests remain green;
- missing `FFMPEG_CONTAINER` surfaces `MEDIA_PROCESSOR_UNAVAILABLE`, never `Cannot read properties of undefined (reading 'getByName')`;
- generated Workers Builds production config retains both the container declaration and `FFMPEG_CONTAINER` durable-object binding.

## 14. Deployment boundary

The production Worker must retain the media container binding used by `ContainerMediaProcessor`. Workers Builds must not generate a production config that removes `containers` or the `FFMPEG_CONTAINER` durable-object binding while workflows still instantiate the container media processor.

If the Workers Builds API token lacks Containers Edit, deployment must fail visibly instead of publishing a Worker that passes HTTP readiness but cannot execute media jobs.

A production build is qualified only after source CI passes and a live media probe proves the container binding is present.

## 15. Success criteria

Phase 4D is complete when:

1. users can export with current `source_mix` unchanged;
2. users can request `preserve_background` when capability is available;
3. the pipeline produces/reuses durable dialogue/background stems through ElevenLabs `two_stems_v1`;
4. dubbed export renders against the background stem;
5. retries are idempotent and usage-safe;
6. missing capability fails with a stable typed error, never `Cannot read properties of undefined (reading 'getByName')`;
7. CI and live container-binding qualification pass.
