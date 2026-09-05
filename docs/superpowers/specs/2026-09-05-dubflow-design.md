# DubFlow — Cloudflare AI Dubbing Studio Design

Date: 2026-09-05
Status: Approved for implementation

## 1. Goal
Build a production-oriented AI dubbing SaaS that covers all three requested scopes:

- A — high-fidelity editor UI inspired by the provided reference image.
- B — working dubbing MVP from upload -> transcription -> translation -> voice generation -> timing -> export.
- C — SaaS layer with projects, jobs, credits, auth-ready boundaries, observability, retries, and cloud deployment.

The system is Cloudflare-first and must not depend on GitHub Actions for build or deployment.

## 2. Product defaults

Product name: DubFlow
Repository name: dubflow
Initial media target: up to 5 GB per source video and up to 3 hours duration.
Primary translated language for V1: Vietnamese.
Initial source languages: Chinese, English, Japanese, Korean, with language auto-detection where reliable.

## 3. Deployment model

Single Cloudflare-first application:

- Frontend: React + TypeScript + Vite, served through Cloudflare Workers Static Assets.
- API: Cloudflare Worker using Hono.
- Object storage: Cloudflare R2.
- Relational metadata: Cloudflare D1.
- Durable pipeline: Cloudflare Workflows.
- AI inference: Workers AI.
- Translation fallback / alternate engine: Google Cloud Translation API.
- Heavy media processing: Cloudflare Container running FFmpeg/ffprobe.
- Observability: Workers logs + AI Gateway where relevant.
- Secrets: Wrangler secrets; no secrets committed to Git.
- Deployment: local/manual Wrangler only; no GitHub Actions.

## 4. UX structure

### 4.1 Studio layout

The editor uses a dark workstation layout with a purple accent, while avoiding direct copying of the reference product's brand identity.

Left column:
- upload/import panel
- media metadata
- detected characters/speakers
- source language
- target language
- start/re-run dubbing pipeline

Center:
- video player
- dual-language subtitles
- transport controls
- current time / duration
- timeline ruler
- video thumbnails
- source subtitle track
- translated subtitle track
- one waveform/audio track per speaker

Right column:
- script / character tabs
- current source segment
- translated segment
- assigned voice
- preview voice
- regenerate segment
- lip-sync / timing option

### 4.2 Editing behavior

Users can:
- select a segment from the player, script panel, or timeline
- edit source or translated text
- split/merge segments
- drag segment timing
- re-run translation for one segment
- choose translation engine per project or segment
- assign a voice per speaker
- regenerate voice for one segment
- mute/solo speaker tracks
- preview a dubbed segment before full export
- export MP4 and subtitle files

## 5. Core domain model

### User
- id
- display_name
- plan
- credit_balance
- created_at

### Project
- id
- user_id
- title
- source_language
- target_language
- status
- source_object_key
- duration_ms
- size_bytes
- created_at
- updated_at

### Speaker
- id
- project_id
- label
- display_name
- voice_provider
- voice_id
- avatar_object_key

### Segment
- id
- project_id
- speaker_id
- start_ms
- end_ms
- source_text
- translated_text
- translation_engine
- translation_status
- voice_status
- dubbed_object_key
- version

### Job
- id
- project_id
- type
- status
- progress
- current_step
- error_code
- error_message
- retry_count
- created_at
- updated_at

### UsageEvent
- id
- user_id
- project_id
- kind
- units
- provider
- cost_basis
- created_at

## 6. Media storage layout

R2 object keys are immutable/versioned where useful:

projects/{projectId}/source/original
projects/{projectId}/audio/source.wav
projects/{projectId}/audio/chunks/{chunkId}.wav
projects/{projectId}/waveform/{speakerId}.json
projects/{projectId}/voices/{segmentId}/{version}.wav
projects/{projectId}/subtitles/source.srt
projects/{projectId}/subtitles/translated.srt
projects/{projectId}/exports/{exportId}.mp4

Uploads use multipart upload directly to R2 through short-lived server-authorized upload sessions. The Worker must not buffer multi-GB video bodies in memory.

## 7. Processing workflow

1. Create project.
2. Initialize multipart R2 upload.
3. Complete upload and validate metadata.
4. Start Workflow instance.
5. FFprobe source.
6. Extract normalized audio using FFmpeg container.
7. Chunk audio for ASR.
8. Workers AI speech-to-text.
9. Normalize timestamps and segments.
10. Speaker segmentation / diarization boundary.
11. Translate segments.
12. Persist editable transcript.
13. Wait for user review or continue with auto mode.
14. Generate per-speaker/per-segment voice audio.
15. Fit generated audio to segment timing.
16. Mix dubbed dialogue and source ambience according to export settings.
17. Generate SRT/VTT.
18. Mux final media with FFmpeg.
19. Write export to R2.
20. Mark job complete and return signed download URL.

Every expensive or externally dependent stage must be idempotent and retry-safe.

## 8. Translation architecture

A provider interface isolates engines:

TranslationProvider.translateBatch(input, context)

Providers:
- WorkersAITranslationProvider
- GoogleCloudTranslationProvider

Modes:
- Fast: Google Cloud Translation
- AI Context: Workers AI contextual translation
- Quality: Google draft -> Workers AI contextual rewrite
- Compare: run both and show differences before accepting

Context passed to AI translation can include:
- project glossary
- character names
- prior/following lines within a bounded window
- speaker identity
- formality level
- genre/style setting

The implementation must protect timestamps and segment identity from LLM rewriting.

## 9. Speech recognition

ASR runs through Workers AI behind an adapter so the selected speech model can change without changing project logic.

Requirements:
- chunk long audio
- preserve time offsets
- normalize punctuation
- retain source-language transcript
- bounded retries
- deterministic segment IDs after normalization

## 10. Voice architecture

VoiceProvider.generate(segment, speakerVoice, options)

Initial provider:
- Workers AI TTS where model/voice quality is acceptable for the chosen language.

Extension boundary:
- optional dedicated voice-cloning provider can be added without changing the editor or project schema.

V1 must not claim speaker voice cloning unless the configured provider explicitly supports cloning with the necessary consent and rights.

## 11. Timing and lip-sync strategy

V1 timing is audio-duration fitting rather than full visual mouth synthesis:
- measure generated audio duration
- apply bounded tempo adjustment
- pad with silence where necessary
- flag segments outside acceptable fit range

Visual lip-sync is a separate optional subsystem and should be enabled only when a suitable model/provider is configured. The UI can expose the control while clearly distinguishing unavailable, queued, and completed states.

## 12. FFmpeg container responsibilities

The media container is intentionally narrow:
- ffprobe metadata
- extract/normalize audio
- create waveform/downsample data if needed
- mix generated dialogue
- preserve or attenuate source channels according to export mode
- mux subtitles/audio/video
- render final output

The Worker never shells out to FFmpeg.

## 13. API surface

Initial REST routes:

POST /api/projects
GET /api/projects
GET /api/projects/:id
DELETE /api/projects/:id

POST /api/projects/:id/uploads
POST /api/projects/:id/uploads/:uploadId/complete

POST /api/projects/:id/process
GET /api/projects/:id/jobs/:jobId

GET /api/projects/:id/speakers
PATCH /api/projects/:id/speakers/:speakerId

GET /api/projects/:id/segments
PATCH /api/projects/:id/segments/:segmentId
POST /api/projects/:id/segments/:segmentId/retranslate
POST /api/projects/:id/segments/:segmentId/regenerate-voice

POST /api/projects/:id/exports
GET /api/projects/:id/exports/:exportId

Job progress uses SSE first. WebSocket support is not required for V1 unless bidirectional realtime behavior becomes necessary.

## 14. Frontend modules

src/app/
src/features/projects/
src/features/upload/
src/features/player/
src/features/timeline/
src/features/transcript/
src/features/speakers/
src/features/voice/
src/features/export/
src/components/ui/
src/lib/api/
src/lib/media/

Important editor components:
- StudioShell
- UploadPanel
- SpeakerList
- VideoStage
- SubtitleOverlay
- ScriptInspector
- Timeline
- TimelineTrack
- WaveformTrack
- SegmentBlock
- VoicePicker
- ExportDialog

Timeline state must be separated from DOM rendering logic so large projects remain testable and performant.

## 15. Worker modules

worker/src/index.ts
worker/src/routes/
worker/src/services/projects.ts
worker/src/services/uploads.ts
worker/src/services/translation/
worker/src/services/asr/
worker/src/services/voice/
worker/src/services/jobs.ts
worker/src/services/exports.ts
worker/src/db/
worker/src/workflows/
worker/src/security/

## 16. Security and abuse controls

- upload type and size validation
- signed/short-lived object access
- no public R2 bucket required
- per-user project authorization on every route
- secrets only through Cloudflare secrets
- provider request timeouts
- bounded retries
- rate limits for expensive operations
- usage ledger written before/after billable stages
- sanitize filenames and metadata
- explicit deletion path for source and generated media
- no silent voice cloning; user must have rights to use source voices

## 17. Credits architecture

Credits are an internal usage ledger first, not a payment system in V1.

Usage units can include:
- ASR audio minute
- translation character/token
- TTS audio second
- render minute
- storage GB-day estimate

Billing provider integration is deferred until the actual processing cost model is measured.

## 18. Failure handling

Job states:
- queued
- running
- needs_review
- retrying
- failed
- completed
- cancelled

Each workflow step records structured error codes. The UI provides actionable retry at project or segment level when safe.

Reruns must not duplicate completed exports or charge duplicate credits for idempotently reused results.

## 19. Testing strategy

Unit tests:
- segment/timing transforms
- translation provider contracts
- credit ledger calculations
- object key generation
- authorization rules

Integration tests:
- D1 repositories
- R2 upload completion
- translation provider mocks
- Workflow state transitions
- export orchestration

Frontend tests:
- timeline selection
- subtitle editing
- speaker assignment
- job progress rendering
- export flow

End-to-end smoke test:
- small fixture video
- upload
- transcribe
- translate
- assign voice
- export
- verify downloadable media and subtitle artifacts

No GitHub Actions workflow is included. Tests are run locally before deployment.

## 20. Deployment commands

Expected developer flow:

npm install
npm run test
npm run build
npx wrangler d1 migrations apply dubflow-db --remote
npx wrangler deploy

Separate container deployment is performed with Cloudflare's supported Wrangler/container flow when the FFmpeg service is introduced.

## 21. Implementation phases

Phase 1 — Foundation + UI
- repository scaffold
- Worker static assets
- D1 schema
- R2 bindings
- studio shell
- upload UI
- video player
- transcript panels
- timeline skeleton

Phase 2 — Working MVP
- multipart upload
- media probe/extract
- ASR
- translation provider router
- editable segments
- TTS adapter
- audio timing
- FFmpeg export

Phase 3 — SaaS hardening
- project dashboard
- durable job UX
- credits ledger
- retry/cancel
- observability
- rate limits
- share/download controls
- provider usage metrics

Phase 4 — Advanced dubbing
- stronger diarization
- dedicated voice-cloning provider if configured
- advanced background/dialogue separation
- optional visual lip-sync provider
- glossary/style presets
- batch/multi-language export

## 22. Non-goals for initial V1

- building a custom foundational TTS model
- training a custom speech-recognition model
- custom payment processor
- unlimited-duration videos
- browser-side full video render
- unofficial Google Translate scraping

Google translation integration uses the official Google Cloud Translation API.

## 23. Success criteria

V1 is successful when a user can:
1. upload a supported video up to the initial target limits;
2. obtain timestamped source transcription;
3. translate it to Vietnamese using Workers AI and/or Google Cloud Translation;
4. edit translated segments;
5. assign a supported voice to each detected/created speaker;
6. generate dubbed segment audio;
7. export a playable dubbed MP4 plus subtitle files;
8. reload the project without losing editor state;
9. see durable processing status and meaningful failures;
10. deploy from a developer machine with Wrangler and no GitHub Actions.
