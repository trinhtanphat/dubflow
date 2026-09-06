# Phase 4D — Background / Dialogue Separation Design

Date: 2026-09-06
Status: Approved in chat; written spec pending user review
Base: `main` at `baa02d2ff62e064ba00abcfe280d098b54074031`
Branch: `feat/phase4d-background-dialogue-separation`

## 1. Goal

Complete the remaining Phase 4 roadmap item for advanced background/dialogue handling without falsely claiming AI source separation when no qualified separation provider is configured.

Phase 4D must improve final dubbed media in two layers:

1. provide a production-safe source-audio preservation mode that keeps music/ambience and attenuates original dialogue under dubbed speech;
2. add a real provider boundary for background/dialogue separation so a qualified provider can later supply reusable stems without changing the export workflow contract again.

The design must preserve all Phase 4C multi-language guarantees, especially immutable export attempts, target-language isolation, retry safety, concrete export sharing, and CI-only GitHub Actions.

## 2. Current state and problem

The current FFmpeg render path builds the final audio from `anullsrc` plus dubbed segment clips. It therefore preserves video but does not preserve the source soundtrack in the canonical dubbed mix.

The current `MediaProcessor.renderExport(...)` boundary already accepts `RenderExportOptions`, and `exportPipeline.ts` already centralizes final render orchestration. Phase 4D extends these existing seams instead of introducing a second render pipeline.

The original product design explicitly called for mixing dubbed dialogue with source ambience according to export settings, and listed advanced background/dialogue separation as a Phase 4 item. That roadmap item is not satisfied by simple volume ducking alone, so this phase distinguishes the two capabilities in names, data, UI, and telemetry.

## 3. Scope

### In scope

- Three explicit dubbed-audio modes:
  - `dubbed_only`
  - `duck_original`
  - `separated_background`
- Source-audio preservation and deterministic dialogue-window ducking in the FFmpeg container.
- A `DialogueSeparationProvider` interface and capability model.
- Durable, immutable, project-scoped background stem metadata and R2 object keys.
- Reuse of one valid background stem across `vi`, `en`, `zh`, `ja`, and `ko` export attempts for the same source generation.
- Fail-closed behavior when `separated_background` is requested without a configured and qualified provider/stem.
- Export API support for selecting the audio mode.
- Cloud Studio export controls that accurately distinguish preservation/ducking from true separation.
- Usage-ledger and telemetry hooks for billable external separation work.
- Cancellation, retry, idempotency, authorization, and source-version invalidation.
- Unit/integration/source acceptance tests and Wrangler dry-run qualification.

### Out of scope

- Visual mouth synthesis or visual lip-sync. That is Phase 4E and gets its own design/spec/plan.
- Training or bundling a large separation model such as Demucs/UVR into the existing FFmpeg container in this phase.
- Browser-side stem separation or rendering.
- Manual production deployment from GitHub Actions.
- Claiming `duck_original` is AI source separation.

## 4. Chosen architecture

Use a hybrid, fail-closed architecture.

### Layer A — deterministic preservation/ducking

`duck_original` is always available when the source contains an audio stream. The FFmpeg container maps the source audio, normalizes it to the render format, applies deterministic attenuation during dubbed speech windows, then mixes the dubbed clips over that attenuated source bed.

This is not called separation. It is source-audio preservation with dialogue-window ducking.

### Layer B — optional true separation

`separated_background` is available only when `DialogueSeparationProvider.capabilities()` reports the provider configured and qualified for the source media and the workflow can obtain a valid background stem artifact.

The provider is responsible only for producing background/dialogue stem artifacts. FFmpeg remains responsible for final timing, mixing, video muxing, and output encoding.

### Why this approach

It improves output quality immediately with a low-risk deterministic path, while creating the correct provider boundary for true separation. It avoids embedding an unqualified heavyweight ML model into the existing FFmpeg container and avoids pretending volume ducking is equivalent to source separation.

## 5. Audio-mode contract

Add a domain type:

```ts
type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';
```

Semantics:

### `dubbed_only`

- Backward-compatible behavior.
- Final audio contains the generated dubbed clips over silence.
- Does not require source audio.
- Existing legacy calls that omit the audio mode resolve to `dubbed_only` so Phase 4D does not silently alter already-qualified output behavior.

### `duck_original`

- Requires a readable source audio stream.
- Preserves source soundtrack.
- Applies attenuation only during intervals containing dubbed dialogue.
- Mixes dubbed clips over the attenuated source bed.
- Does not create or persist a background stem.
- Does not use or meter a separation provider.

### `separated_background`

- Requires a qualified separation capability.
- Uses a durable background stem created for the current source generation.
- Final mix uses the background stem plus dubbed dialogue, not the original mixed soundtrack.
- If the provider is unavailable, unqualified, returns an invalid artifact, or cannot process the source, the export fails with a stable capability/provider error. It must not silently downgrade to `duck_original`.

## 6. Dialogue-window ducking behavior

Ducking windows are derived from the same canonical export clips used for dubbed timing.

Rules:

- Each clip contributes `[startMs, endMs)`.
- Overlapping or adjacent windows are merged before building the FFmpeg expression/filter graph.
- A small deterministic attack/release envelope may be used to avoid hard gain edges, but it must be bounded and unit-tested.
- Gain values are constants/configurable code defaults, not user-provided arbitrary FFmpeg expressions.
- The source bed is normalized/resampled to 48 kHz stereo before ducking and mixing.
- No clip or source path from another project may be accepted.
- Output duration remains bounded to canonical project duration.

Initial default attenuation: approximately -18 dB during dubbed speech windows. The exact linear gain constant is implementation detail but must be locked by tests so changes are deliberate.

## 7. Separation provider boundary

Add a service interface independent from the media renderer:

```ts
type DialogueSeparationCapabilities = {
  configured: boolean;
  provider: string | null;
  backgroundStem: boolean;
  dialogueStem: boolean;
  maxDurationMs?: number;
  supportedContentTypes?: string[];
  qualification: 'qualified' | 'unqualified' | 'unavailable';
};

type SeparateDialogueInput = {
  projectId: string;
  sourceObjectKey: string;
  sourceGeneration: number;
  durationMs: number;
};

type SeparationResult = {
  provider: string;
  providerVersion?: string;
  backgroundObjectKey: string;
  dialogueObjectKey?: string | null;
};

interface DialogueSeparationProvider {
  capabilities(): Promise<DialogueSeparationCapabilities>;
  separate(input: SeparateDialogueInput): Promise<SeparationResult>;
}
```

The provider may be implemented later using a dedicated API/service. Phase 4D must ship a clean unavailable provider implementation so the application can safely expose the capability state before a production provider is configured.

Provider qualification is explicit. `configured=true` is not sufficient for `separated_background`; capability must also be `qualification='qualified'` and `backgroundStem=true`.

## 8. Persistence and source generation

Create a forward D1 migration for separation artifacts. Use one canonical table, for example:

`project_audio_stems`

Required fields:

- `id`
- `project_id`
- `source_generation`
- `kind` (`background` or `dialogue`)
- `provider`
- `provider_version`
- `status` (`pending`, `completed`, `failed`, `invalidated`)
- `object_key`
- `error_code`
- `error_message`
- `created_at`
- `updated_at`

Uniqueness must prevent two completed canonical stems of the same kind/provider/source generation from becoming competing sources of truth.

The project source generation must change whenever the uploaded source media is replaced/recompleted. If the repo already has an equivalent source-version field after latest-main reconciliation, use that instead of introducing a duplicate counter.

Changing the source generation invalidates old stem rows for future reuse. Existing immutable R2 artifacts may remain for retention/cleanup policy, but must never be selected for a newer source generation.

## 9. R2 object layout

Canonical stem keys:

```text
projects/{projectId}/stems/{sourceGeneration}/{provider}/background.wav
projects/{projectId}/stems/{sourceGeneration}/{provider}/dialogue.wav
```

Requirements:

- immutable for a source generation/provider identity;
- project-scoped;
- never derived directly from untrusted filenames;
- validated before persistence and before media rendering;
- background stem is required for a completed separation result;
- dialogue stem is optional because Phase 4D final rendering only requires the background stem.

## 10. Workflow and reuse

True separation is a project/source-generation operation, not a target-language operation.

For a `separated_background` dubbed export:

1. Authorize project/export/job.
2. Load target-language variants and generate/reuse TTS exactly as Phase 4C does today.
3. Resolve current source generation.
4. Load a completed valid background stem for that source generation/provider.
5. If none exists, check provider capabilities before any provider side effect.
6. Record usage `started` with an idempotent operation key.
7. Run provider separation once.
8. Validate provider object keys/project scope and required background artifact.
9. Persist completed stem metadata.
10. Record usage `completed`.
11. Pass the background stem key to `MediaProcessor.renderExport(...)`.
12. FFmpeg mixes the background stem plus target-language dubbed clips.
13. Publish the normal immutable target export attempt.

A second export for another target language reuses the same completed background stem and must not run the provider again.

Retries use the existing job retry-generation/idempotency pattern. A durable completed stem wins over an incomplete usage record; the workflow recovers the missing usage completion rather than rerunning the provider.

## 11. MediaProcessor / container contract

Extend `RenderExportOptions` without creating a new renderer:

```ts
type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  audioMode?: DubbedAudioMode;
  backgroundObjectKey?: string;
};
```

Rules:

- omitted `audioMode` -> `dubbed_only`;
- `duck_original` forbids `backgroundObjectKey`;
- `separated_background` requires a validated project-scoped background stem key;
- `dubbed_only` ignores/forbids background stem input;
- modern output key naming remains unchanged;
- legacy render path remains backward-compatible.

Container input validation must reject cross-project source, voice, and stem objects before fetching or invoking FFmpeg.

## 12. FFmpeg render design

### `dubbed_only`

Keep the existing filter graph behavior.

### `duck_original`

Inputs:

- source media including original audio;
- dubbed clips.

Filter graph:

- map original audio to normalized source bed;
- apply gain automation based on merged dialogue windows;
- place/tempo-fit dubbed clips exactly as current implementation;
- mix attenuated source bed and dubbed clips;
- encode AAC 48 kHz stereo.

If source media contains no audio stream, return a stable `SOURCE_AUDIO_MISSING` media error rather than silently falling back.

### `separated_background`

Inputs:

- source video;
- background stem;
- dubbed clips.

Filter graph:

- normalize background stem;
- place/tempo-fit dubbed clips;
- mix background stem and dubbed clips;
- do not also mix original source audio;
- preserve video timing and normal export encoding.

The container does not run the external separation provider.

## 13. API behavior

Extend dubbed export requests with optional:

```json
{
  "audioMode": "dubbed_only | duck_original | separated_background"
}
```

For batch exports, one requested audio mode applies to all target-language dubbed attempts in that batch. Subtitle-only attempts ignore audio mode and must reject nonsensical separation-only fields if supplied.

Responses include the resolved audio mode in export attempt DTOs so UI and diagnostics can distinguish how an artifact was produced.

Stable errors include:

- `AUDIO_MODE_INVALID`
- `SOURCE_AUDIO_MISSING`
- `DIALOGUE_SEPARATION_UNAVAILABLE`
- `DIALOGUE_SEPARATION_UNQUALIFIED`
- `DIALOGUE_SEPARATION_FAILED`
- `DIALOGUE_SEPARATION_ARTIFACT_INVALID`

Ownership hiding remains unchanged: unauthorized project/export IDs must not leak existence.

## 14. UI design

Add an audio treatment control in the export/batch-export area rather than the segment inspector.

Labels must be explicit:

- `Dubbed voice only`
- `Keep original ambience (duck dialogue)`
- `Separated background stem`

The UI shows provider capability state for true separation:

- unavailable — disabled with explanation;
- configured but unqualified — disabled with qualification warning;
- qualified — selectable;
- processing — export/job progress indicates separation stage;
- failed — actionable provider error without silently changing mode.

The UI must never label `duck_original` as AI separation.

## 15. Usage ledger and telemetry

Add a separation usage kind only when external/provider work is actually performed. The exact unit should follow provider billing semantics; if no provider is configured, do not invent cost units.

Required operation-key dimensions:

- project ID
- source generation
- provider
- provider version where relevant
- stage `dialogue-separation`

Telemetry events should include provider/status/duration/error code but no transcript text, source media bytes, credentials, or private filenames.

FFmpeg ducking stays part of normal render metering and does not create a fake AI separation usage event.

## 16. Cancellation and failure handling

- Check cancellation before provider call, before final render, and before publish.
- Provider timeout/failure marks the stem attempt failed and the export job failed with a stable code.
- A failed provider attempt does not invalidate already-completed stems from the same valid source generation/provider.
- A completed stem must be validated again before reuse.
- No automatic downgrade from `separated_background` to another audio mode.
- `duck_original` failures are media/render failures, not separation-provider failures.
- Existing completed target exports remain immutable even if future separation capability changes.

## 17. Security and abuse controls

- Per-user project authorization before any stem lookup/provider call.
- Strict project-prefix validation for source/voice/stem R2 keys.
- Provider secrets remain Cloudflare secrets, never D1/Git/docs/tests.
- Provider calls have bounded timeout/retry policy.
- Source duration/provider limits are checked before billable work.
- Rate limiting reuses the expensive export admission boundary unless a provider-specific rate-limit binding becomes necessary during implementation; no new binding should be added without evidence.
- Never send transcript text to a separation provider unless its API specifically requires it; the expected input is source media/audio only.

## 18. Compatibility guarantees

Phase 4D must not regress:

- Phase 4C target languages `vi/en/zh/ja/ko`;
- target-specific voice artifact keys;
- batch partial retry isolation;
- concrete export sharing through `export_id`;
- Vietnamese project-level export compatibility;
- subtitle export behavior;
- dedicated batch-export rate limit;
- source/CI migration checks;
- Cloudflare Workers Builds as the only production deployment lane.

Existing clients that omit `audioMode` retain `dubbed_only` behavior.

## 19. Testing strategy

### Domain/unit

- audio-mode parsing/defaulting;
- capability qualification matrix;
- source-generation stem selection/invalidation;
- operation-key determinism;
- provider result validation;
- reuse of one stem across multiple target languages.

### Container

- `dubbed_only` retains current argument/filter graph contract;
- `duck_original` maps source audio and applies attenuation windows;
- overlapping dialogue windows merge deterministically;
- source audio absent -> stable failure;
- `separated_background` consumes background stem and does not mix source audio;
- cross-project stem key rejected;
- output duration/video mapping remains correct.

### Workflow

- provider capability checked before side effect;
- unavailable/unqualified is fail-closed;
- provider called once for first target export and reused for later languages;
- retry recovers completed durable stem without double provider call/usage charge;
- cancellation boundaries;
- provider failure does not publish export;
- `duck_original` never touches separation provider/usage;
- legacy export omission remains `dubbed_only`.

### API/UI

- audio mode accepted for dubbed single/batch export;
- invalid mode rejected;
- subtitle requests do not start separation;
- UI labels distinguish ducking vs true separation;
- separation option disabled unless qualified;
- job/error state rendered accurately.

### Acceptance

Add a Phase 4D acceptance test wired into the normal verification script. It must assert source/API/runtime wiring, no production deploy workflow, migration ordering, provider fail-closed behavior, and compatibility with Phase 4C.

CI gate remains:

- all source/acceptance tests;
- all unit/integration tests;
- TypeScript/Vite production build;
- Wrangler deploy dry-run;
- existing reference screenshot gate where affected.

## 20. Delivery sequence

Implementation will be split into small TDD slices after this spec is approved:

1. Domain audio-mode contract + RED tests.
2. D1 stem persistence/source-generation compatibility.
3. Separation provider capability interface + unavailable implementation.
4. Stem orchestration/reuse/idempotency in export workflow.
5. MediaProcessor contract extension.
6. FFmpeg `duck_original` render path.
7. FFmpeg `separated_background` render path.
8. Single/batch export API wiring.
9. Export UI capability/mode controls.
10. Usage/telemetry/error contracts.
11. Phase 4D acceptance/docs and exact-head CI.
12. Review, PR, expected-head merge to `main`, post-merge CI.

No manual production deployment is part of this sequence.

## 21. Phase 4E boundary

Visual lip-sync remains a separate subsystem. Phase 4D may not add a fake lip-sync provider or reinterpret audio duration fitting as visual lip-sync.

After Phase 4D is merged and post-merge CI is green, Phase 4E will get a separate architectural spec covering:

- visual lip-sync provider capabilities;
- immutable visual-render attempts;
- per-export opt-in;
- provider qualification and safety boundary;
- queued/completed/unavailable UI state;
- no-op/fail-closed behavior when provider is absent.

## 22. Acceptance criteria

Phase 4D is complete when all of the following are true:

1. Existing clients still produce `dubbed_only` exports unchanged when `audioMode` is omitted.
2. `duck_original` produces a render contract that preserves source audio and attenuates it only around dubbed speech windows.
3. `separated_background` is impossible to request successfully unless a qualified provider/stem path exists.
4. A valid background stem is reusable across all enabled target languages for the same source generation.
5. Replacing source media prevents reuse of old stems.
6. Provider retries do not create duplicate canonical stems or duplicate completed usage charges.
7. Cross-project source/voice/stem paths are rejected.
8. Batch export preserves partial retry isolation and its dedicated rate limit.
9. Concrete export sharing and Vietnamese compatibility remain intact.
10. Full exact-head CI and post-merge CI complete successfully.
11. GitHub Actions performs no production deployment.
12. Production capability is not called qualified until real provider/media fixtures prove it outside the source-only CI boundary.
