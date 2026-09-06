# DubFlow Phase 4D — Dialogue / Background Separation Design

Date: 2026-09-06
Status: Approved direction; written for review

## 1. Goal

Add an optional, durable dialogue/background stem-separation stage to the dubbing/export pipeline so dubbed speech can replace source dialogue while preserving ambience/music more cleanly than the current full-source mix.

Phase 4D must not weaken the existing export path. If separation is unavailable or not requested, the current source-media + dubbed-clips render remains the fallback.

## 2. Scope

Phase 4D covers:

- a provider boundary for source stem separation;
- durable R2 object keys for dialogue/background stems;
- orchestration from export into separation only when requested and supported;
- FFmpeg-container render support for using the background stem as the base audio;
- idempotency, usage accounting, telemetry, retries and cancellation;
- API/UI capability reporting so the feature is exposed only when available;
- regression coverage that protects the existing export path.

Phase 4D does not add visual lip-sync. That is Phase 4E.

## 3. Design choice

Use a dedicated `StemSeparationProvider` interface rather than hard-coding a specific model into export orchestration.

The first implementation is model-backed and container-oriented: the existing media container remains the execution boundary for heavy media work, and the Worker/Workflow never shells out directly. The provider returns immutable project-scoped R2 keys for dialogue/background stems.

The provider boundary keeps the rest of DubFlow independent from the concrete separation engine, so a future hosted provider can replace the first implementation without changing export contracts.

## 4. Capability and fallback rules

Separation is opt-in per export.

Export modes:

- `source_mix` — current behavior; no stem separation required.
- `preserve_background` — requires a separation provider and a completed background stem.

If `preserve_background` is requested but the provider/binding is unavailable, fail with a stable capability error before billable processing starts. Do not silently pretend separation happened.

If separation itself fails after admission, the export job fails with an actionable error and can be retried. The existing `source_mix` path remains available as a user-selectable fallback.

## 5. Storage contract

Use immutable/versioned project-scoped keys:

- `projects/{projectId}/stems/{sourceRevision}/dialogue.wav`
- `projects/{projectId}/stems/{sourceRevision}/background.wav`

`sourceRevision` must change when the source media identity changes. Reusing a completed stem pair for the same source revision is allowed and should avoid duplicate provider work and duplicate usage charges.

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

Media render options gain an optional `backgroundObjectKey`. The media layer validates that the key belongs to the same project and expected stems folder before calling the container.

## 7. Export flow

For dubbed exports:

1. authorize project and load job retry generation;
2. load source segments / target-language variants;
3. generate or reuse voice clips as today;
4. when `separationMode === 'preserve_background'`, load or create the durable stem pair;
5. record provider usage/telemetry idempotently;
6. call media render with dubbed clips and optional background stem;
7. publish export and complete the job.

Subtitle-only export never invokes stem separation.

## 8. Container responsibilities

The container API adds a separation endpoint and extends render input:

- `POST /separate-stems`
- `POST /render-export` accepts optional `backgroundObjectKey`

The render helper uses the background stem as the retained source-audio bed when present, then overlays duration-fitted dubbed clips. Without a background stem, current behavior is unchanged.

The Worker continues to interact with media through the container namespace; it never buffers large media files or invokes local FFmpeg.

## 9. Error handling

Stable errors include:

- `STEM_SEPARATION_UNAVAILABLE`
- `STEM_SEPARATION_FAILED`
- `STEM_SEPARATION_RESPONSE_INVALID`
- `MEDIA_BACKGROUND_STEM_INVALID`

The current raw JavaScript failure surface must never leak to users. Missing media/container capability must become a typed application error.

## 10. Usage and observability

Add one usage kind for separation runtime, measured in source audio seconds:

- `stem_separation_audio_second`

Use the existing started/completed operation-key pattern so retries do not double-charge completed work.

Telemetry emits provider start/success/failure with project/job/request correlation but never media/transcript content.

## 11. UI/API

Expose a capability object with at least:

```json
{
  "dialogueBackgroundSeparation": {
    "available": true,
    "modes": ["source_mix", "preserve_background"]
  }
}
```

The export UI shows “Preserve background/music” only when capability is available. Otherwise it stays disabled with an explanatory reason; `source_mix` remains usable.

## 12. Testing

Required tests:

- provider contract and object-key validation;
- export pipeline does not invoke separation in `source_mix`;
- `preserve_background` reuses existing completed stems;
- failed provider does not mark export complete;
- retry/idempotency does not duplicate usage completion;
- render request carries the validated background stem;
- current legacy and multi-language export tests remain green;
- missing `FFMPEG_CONTAINER`/provider surfaces a stable capability error rather than a JavaScript TypeError.

## 13. Deployment boundary

The production Worker must retain the media container binding used by `ContainerMediaProcessor`. Workers Builds must not generate a production config that removes `FFMPEG_CONTAINER` while workflows still instantiate the container media processor.

A production build is qualified only after source CI passes and a live media probe proves the container binding is present.

## 14. Success criteria

Phase 4D is complete when:

1. users can export with current `source_mix` unchanged;
2. users can request `preserve_background` when capability is available;
3. the pipeline produces/reuses durable dialogue/background stems;
4. dubbed export renders against the background stem;
5. retries are idempotent and usage-safe;
6. missing capability fails with a stable typed error, never `Cannot read properties of undefined (reading 'getByName')`;
7. CI and live container-binding qualification pass.
