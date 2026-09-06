# Phase 4D — Hybrid Background / Dialogue Treatment Design

Date: 2026-09-06
Status: User-approved in current chat
Base: `main@17ad67a0fe350141ea59ae1bfa55dc52be8c5072`
Carrier: `feat/phase4d-hybrid-audio-treatment`

## Goal

Complete the advanced background/dialogue handling roadmap item without falsely claiming source separation when no qualified separation provider exists.

Phase 4D adds three explicit dubbed-audio modes while preserving all Phase 4C multi-language/export guarantees:

```ts
type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';
```

`dubbed_only` remains the compatibility default. `duck_original` is deterministic source-audio preservation with dialogue-window ducking. `separated_background` is true provider-backed background-stem rendering and always fails closed unless a qualified provider and valid current-generation background stem exist.

## Current seam

The canonical FFmpeg renderer currently builds final audio from `anullsrc` plus dubbed clips. `MediaProcessor.renderExport(...)` already accepts `RenderExportOptions`, and `exportPipeline.ts` already centralizes final render orchestration. Phase 4D extends these seams instead of adding a second export pipeline.

## Audio modes

### `dubbed_only`

- Existing behavior: dubbed clips over silence.
- No source audio or separation provider required.
- Omitted `audioMode` resolves here.

### `duck_original`

- Requires readable source audio.
- Preserves the source soundtrack.
- Attenuates source audio exactly `-18 dB` during dubbed speech windows.
- Attack lead is `80 ms`; release tail is `120 ms`.
- Overlapping/adjacent windows merge deterministically.
- Mixes target-language dubbed clips over the attenuated source bed.
- Never touches separation provider state or provider usage metering.
- UI copy must call this source-audio preservation/ducking, never AI separation.

### `separated_background`

- Requires provider capabilities: `configured=true`, `qualification='qualified'`, `backgroundStem=true`, and a non-empty provider identity.
- Uses a project/source-generation/provider-scoped durable background stem.
- Does not mix original source audio.
- Never silently downgrades to another audio mode.
- Provider unavailable/unqualified/invalid/failure becomes a stable export failure.

## Source identity

Add `projects.source_generation INTEGER NOT NULL DEFAULT 1`.

Semantics:

- existing projects and new projects begin at generation `1`;
- first durable source assignment keeps generation `1`;
- replaying completion for the same source object key is idempotent and keeps the same generation;
- replacing the source with a different durable object increments the generation exactly once;
- older stems are never selected for a newer generation.

## Persistence

Forward migration `0011_phase4d_audio_separation.sql` adds:

- `projects.source_generation`;
- `project_exports.audio_mode` with default `dubbed_only`;
- canonical table `project_audio_stems`.

Required stem fields:

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
- timestamps.

Only one active (`pending` or `completed`) row may exist per project/source-generation/kind/provider. Failed rows must not permanently prevent retry. Source-generation changes invalidate older active rows for future reuse.

## R2 keys

```text
projects/{projectId}/stems/{sourceGeneration}/{provider}/background.wav
projects/{projectId}/stems/{sourceGeneration}/{provider}/dialogue.wav
```

All provider and renderer boundaries validate exact project/source-generation prefixes before fetch/persistence.

## Provider boundary

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

Phase 4D ships a safe unavailable provider implementation. It does not bundle a heavyweight separation model into the existing FFmpeg container and does not pretend the provider exists. A provider-specific future change can implement this interface without altering export/media contracts.

## Workflow reuse and idempotency

True separation is project/source-generation scoped, not target-language scoped. For `separated_background`:

1. authorize project/export/job;
2. load current source generation;
3. require qualified provider capability before billable side effects;
4. reuse a completed valid current-generation background stem when present;
5. otherwise create/claim a pending stem row;
6. record provider usage `started` using an idempotent operation key;
7. call provider once;
8. validate returned keys;
9. persist completed stem metadata;
10. record usage `completed`;
11. render using the background stem plus target-language dubbed clips.

A later language export reuses the same completed background stem. Completed accounting without a durable valid stem fails closed rather than blindly repeating billable work.

## Media contract

Extend `RenderExportOptions`:

```ts
type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  audioMode?: DubbedAudioMode;
  backgroundObjectKey?: string;
};
```

Rules:

- omitted mode -> `dubbed_only`;
- `duck_original` forbids `backgroundObjectKey`;
- `separated_background` requires validated `backgroundObjectKey`;
- modern output naming remains unchanged;
- legacy render remains backward-compatible.

## API and UI

Single and batch dubbed export requests accept optional `audioMode`. One batch mode applies to every dubbed target attempt. Subtitle requests do not start separation and reject non-default audio treatment.

Stable errors include:

- `AUDIO_MODE_INVALID`
- `SOURCE_AUDIO_MISSING`
- `DIALOGUE_SEPARATION_UNAVAILABLE`
- `DIALOGUE_SEPARATION_UNQUALIFIED`
- `DIALOGUE_SEPARATION_FAILED`
- `DIALOGUE_SEPARATION_ARTIFACT_INVALID`.

Cloud Studio export controls use explicit labels:

- `Dubbed voice only`
- `Keep original ambience (duck dialogue)`
- `Separated background stem`.

The separated option is disabled unless capability is qualified.

## Security / operations

- Authorize before stem lookup/provider call.
- Strict project-prefix validation for source, voice, and stem keys.
- Provider secrets stay in Cloudflare secrets.
- Provider calls are bounded and retry-safe.
- `duck_original` remains normal render metering and does not produce fake separation usage.
- GitHub Actions remains CI-only.
- Cloudflare Workers Builds remains the only production deployment lane.
- No manual production deployment in this phase.

## Testing and completion

TDD must cover domain parsing, migration/source-generation semantics, owner-scoped stem reuse, provider qualification/failure, FFmpeg window merge and three render modes, single/batch API behavior, UI wording/capability gating, cancellation/idempotency, and preservation of Phase 4C sharing/rate-limit/deploy guards.

Completion requires fresh exact-head CI, PR CI, expected-head merge, and post-merge CI on the exact merge SHA. Source/CI qualification does not qualify production provider/media quality.