# Zero-Container Media Pipeline Design

## Goal

Remove the FFmpeg Cloudflare Container dependency from both dubbing and export while preserving YupVox's current project/job/R2/D1 contracts and keeping the public workflow behavior stable.

## Current failure

Production dubbing reaches the media stage and fails because `DubbingWorkflow` constructs `ContainerMediaProcessor` from `env.FFMPEG_CONTAINER`; the live deployment can reach D1/R2/Workflow but the container binding path is not reliable. `ExportWorkflow` has the same runtime dependency. The result is a class of deployment failures that CI does not currently prevent.

## Design principles

- R2 remains the durable source-of-truth for uploaded media and final exports.
- D1 remains the source-of-truth for projects, jobs, segments, translations, and export state.
- Cloudflare Workflows remain the orchestration layer.
- No Docker image, Container binding, Durable Object container class, or FFmpeg runtime remains in the Worker deployment.
- Large media must not be read fully into Worker memory.
- Media execution must fail fast with explicit configuration/readiness errors.
- Existing API object-key contracts remain stable unless a migration is explicitly required.

## A. Dubbing path

### Ingest

After multipart upload completes in R2, the Worker creates or reuses a Cloudflare Stream asset for the source object. The project stores the Stream video UID in D1. Ingest is idempotent: an existing UID is reused when the source object has not changed.

The Stream asset is created by URL-based ingest through a short-lived, project-scoped signed media URL. The signed URL must not expose R2 credentials and must expire quickly.

### Audio extraction and ASR

The dubbing workflow waits for Stream readiness, obtains an audio-only downloadable representation, and passes a remote URL to the Deepgram pre-recorded API when Deepgram is configured. This removes Worker-side FFmpeg chunk extraction and avoids downloading the full media into Worker memory.

When Deepgram is not configured, the current Workers AI fallback remains supported only for inputs that satisfy the provider's direct payload limits. If the media exceeds those limits, the job fails with an explicit configuration error instructing that the long-form ASR provider is unavailable.

Deepgram utterance timestamps and diarization are converted directly into the existing stitched/reconciled segment model. The downstream translation/editor path remains unchanged.

### Progress

The job stages become: `preparing` -> `stream_ingest` -> `transcribing` -> `translating` -> `needs_review`. UI polling must surface the backend error message instead of leaving the button looking inert.

## B. Export path

### Voice generation

ElevenLabs remains the TTS provider. For export rendering, request PCM output instead of MP3 so the Worker can reason about duration and samples without FFmpeg probing.

Each synthesized segment is persisted in R2 under the existing project-scoped voice namespace. Duration is derived from PCM byte length and sample format. The export pipeline validates that every clip duration is positive and that clip timing is ordered.

### Timeline assembly

Build one project-length dubbed soundtrack as a streaming WAV/PCM object in R2. The assembler writes silence for gaps, writes or resamples each TTS segment into its target `startMs..endMs` window, and truncates/pads deterministically when necessary. The implementation must be streaming/chunked and must not allocate a project-length buffer in memory.

The time-fit policy preserves the current contract previously provided by FFmpeg `atempo`: each clip must occupy its target segment duration. Resampling must preserve channel/sample-rate invariants and reject impossible or malformed inputs.

### Final MP4

Attach the completed dubbed soundtrack to the source Stream asset as an additional audio track using Cloudflare Stream's API, mark it as the selected/default dubbed audio track for the export operation, request/generate a downloadable MP4, and stream the result back into the existing R2 export key:

- legacy: `projects/<projectId>/export/dubbed.mp4`
- target-language: `projects/<projectId>/exports/<targetLanguage>/<exportId>.mp4`

Subtitle-only export remains unchanged.

The Worker secret `CLOUDFLARE_STREAM_API_TOKEN` is required for audio-track mutation operations. It is never committed. Missing binding/secret conditions must fail readiness before an export job is queued.

## Data model

Add nullable Stream provenance to projects:

- `stream_video_uid`
- `stream_source_object_key`
- `stream_ready_at`

The source-object key is stored alongside the UID so a replacement upload invalidates the old Stream asset association.

No existing project or export row is invalidated by migration; existing rows receive `NULL` Stream fields and are ingested lazily on first process/export.

## Worker environment

Add the required Stream binding/configuration and Stream API credentials to `Env` and deployment configuration. Remove:

- `FFMPEG_CONTAINER`
- container Durable Object binding/export
- `containers` section from Wrangler
- `FfmpegContainer` class export
- runtime `ContainerMediaProcessor`
- FFmpeg container image/scripts after all call sites are removed

## Service boundaries

Introduce focused services:

- `StreamMediaService`: source ingest, readiness, audio URL, downloadable MP4, additional-audio-track operations.
- `RemoteAsrProvider` capability: remote-URL transcription for Deepgram while preserving the existing array-buffer interface for Workers AI fallback.
- `PcmTimelineAssembler`: PCM duration validation, time-fit/resample, streamed WAV timeline generation.
- `StreamMediaProcessor`: implements the existing media-facing workflow contracts without Container calls.

Workflow files depend on these interfaces, not directly on Cloudflare API details.

## Error handling and readiness

Before queuing dubbing/export, readiness checks validate the bindings/secrets needed for the requested operation. Runtime errors use explicit codes such as:

- `STREAM_BINDING_UNAVAILABLE`
- `STREAM_INGEST_FAILED`
- `STREAM_NOT_READY`
- `ASR_LONG_FORM_UNAVAILABLE`
- `PCM_TIMELINE_INVALID`
- `STREAM_AUDIO_TRACK_FAILED`
- `STREAM_DOWNLOAD_FAILED`

Job failure persistence and project status behavior remain consistent with the current pipelines.

## UI behavior

`Bắt đầu Dubbing AI` retains the existing upload/create/start contract. The UI additionally displays the current backend job stage and the persisted job error message when processing fails. A successful upload must no longer appear as a no-op after the workflow starts.

The current behavior that creates a project from the uploaded filename remains unchanged in this change set; project-selection semantics are outside this bug fix.

## Tests

Use TDD and add coverage for:

1. Stream ingest idempotency and source replacement invalidation.
2. Dubbing pipeline using remote Stream audio without `FFMPEG_CONTAINER`.
3. Deepgram remote URL request shape and diarized response conversion.
4. Explicit long-form failure when only Workers AI fallback is available for oversized media.
5. PCM duration calculation and deterministic time-fit behavior.
6. Streaming WAV timeline generation with silence gaps and multiple clips.
7. Export pipeline attaching the dubbed audio track and publishing the final MP4 to the exact existing R2 key.
8. Missing Stream secret/binding readiness failures before job creation.
9. UI display of backend job failure/stage.
10. Repository/deployment regression guard asserting no Container/FFmpeg runtime configuration remains.

## Rollout

1. Land migration and zero-container services behind the current workflow contracts.
2. Switch DubbingWorkflow and ExportWorkflow to the new services.
3. Remove Container deployment/runtime code after tests prove no references remain.
4. Run unit/integration/build CI on the feature head.
5. Merge only with full green CI and no drift conflicts with `main`.
6. Verify production by uploading a real video, confirming dubbing passes the old 5% failure point and reaches transcript/review, then creating a dubbed MP4 export that exists in R2 and is playable.

## Non-goals

- Changing the editor data model.
- Replacing D1, R2, Workflows, Deepgram, or ElevenLabs.
- Reworking project creation/selection UX beyond surfacing job state/errors.
- Keeping a hidden FFmpeg fallback.
