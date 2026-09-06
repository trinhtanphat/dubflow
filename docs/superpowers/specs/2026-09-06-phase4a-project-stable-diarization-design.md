# Phase 4A — Project-Stable Diarization Design

Date: 2026-09-06
Status: Approved for implementation

## 1. Goal

Upgrade DubFlow's existing diarized ASR so one real speaker can retain one project-stable speaker identity across bounded audio chunks and across safe ASR reruns, without introducing biometric embeddings, a new ASR provider, voice cloning, or a new billing model.

Phase 4A must preserve the current Cloudflare-first architecture and the existing Deepgram Nova-3 diarized ASR adapter. The feature improves speaker identity continuity around chunk boundaries while keeping the existing 3-hour media target, bounded retries, D1 persistence, Phase 3B usage ledger, Phase 3C telemetry, and editor voice assignment behavior intact.

## 2. Existing system and exact gap

The current system already has:

- FFmpeg container audio extraction into bounded WAV chunks;
- Deepgram Nova-3 diarization that emits `speakerIndex` for utterances;
- Workers AI ASR fallback without diarized speaker labels;
- deterministic ASR segment normalization;
- D1 `speakers` and `segments.speaker_id` persistence;
- per-speaker display-name and ElevenLabs voice assignment;
- export invalidation when speaker voice mappings change;
- Phase 3B append-only provider usage accounting;
- Phase 3C provider telemetry and request correlation.

The current normalization derives speaker identity from `projectId + chunkId + speakerIndex`. This makes speaker IDs deterministic only inside a chunk. If the same person speaks on both sides of a five-minute chunk boundary, Deepgram may label that person as speaker 0 in one chunk and speaker 1 or 2 in the next chunk, and DubFlow currently persists two unrelated speaker rows.

Phase 4A fixes that boundary problem.

## 3. Scope

### In scope

- overlapping FFmpeg audio chunks for diarized ASR;
- project-relative chunk window metadata;
- deterministic overlap utterance deduplication;
- conservative adjacent-chunk speaker stitching;
- deterministic project-stable speaker IDs for a processing run;
- safe reuse of existing speaker IDs on rerun when evidence is unambiguous;
- preserving existing speaker display names and voice assignments when an old speaker ID is reused;
- usage accounting for all provider-processed audio, including overlap seconds;
- unit/integration/acceptance tests for the new contracts;
- source/CI documentation.

### Out of scope

- voice embeddings, speaker biometric templates, voiceprints, or biometric clustering;
- speaker recognition across unrelated projects;
- voice cloning;
- visual face tracking or lip-sync;
- source separation;
- new payment, quota, or pricing behavior;
- changing the ASR provider selection policy;
- production runtime qualification or production deployment.

## 4. Chosen architecture

Phase 4A uses adjacent-chunk overlap plus deterministic transcript/time evidence.

The FFmpeg container keeps a nominal 300-second chunk size and introduces a 15-second overlap between consecutive chunks. A chunk therefore has an absolute project window:

- `offsetMs`: project-relative start of the chunk;
- `durationMs`: actual chunk duration;
- `overlapBeforeMs`: overlap inherited from the prior chunk, zero for the first chunk;
- `overlapAfterMs`: overlap shared with the next chunk, zero for the last chunk.

The system still sends each chunk independently to ASR. Deepgram returns chunk-local utterance times and local speaker indexes. After all chunks are transcribed, a new stitching module converts them to absolute time, removes duplicate overlap utterances, then derives project-level speaker clusters from strong matches in adjacent overlap windows.

The algorithm is intentionally conservative: an uncertain match results in separate speakers rather than an incorrect merge.

## 5. Media chunk contract

### Constants

- nominal chunk length: `300_000 ms`;
- overlap: `15_000 ms`;
- step between chunk starts: `285_000 ms`.

The container must reject invalid overlap configuration. Phase 4A uses fixed production values; the Worker does not expose arbitrary user-controlled chunk or overlap values.

### Object keys

Audio chunk objects remain project-scoped under:

`projects/{projectId}/audio/{index}.wav`

The object-key namespace does not change.

### Returned metadata

`AudioChunk` becomes:

```ts
export type AudioChunk = {
  objectKey: string;
  offsetMs: number;
  durationMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
};
```

The first chunk has `overlapBeforeMs = 0`; the last chunk has `overlapAfterMs = 0`. Interior chunks use the fixed overlap where media duration permits it.

The Worker validates that all fields are finite non-negative integers, that duration is positive, and that overlap values do not exceed duration.

## 6. ASR observation model

The existing provider response remains unchanged:

```ts
export type AsrSegment = {
  startMs: number;
  endMs: number;
  text: string;
  speakerIndex?: number;
};
```

Phase 4A introduces an internal stitching observation type rather than expanding provider contracts:

```ts
export type DiarizedObservation = {
  projectId: string;
  chunkId: string;
  chunkOrder: number;
  offsetMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
  localSegmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerIndex?: number;
};
```

`startMs` and `endMs` in this type are absolute project timestamps.

Provider adapters remain unaware of cross-chunk stitching.

## 7. Text normalization for overlap matching

Overlap comparison uses a deterministic, language-agnostic normalization function:

1. Unicode NFKC normalization;
2. trim leading/trailing whitespace;
3. lowercase where the runtime locale rules are deterministic through `toLocaleLowerCase('en-US')` only for Latin case folding;
4. collapse all Unicode whitespace runs to one ASCII space;
5. remove punctuation and symbol characters using Unicode character classes `\p{P}` and `\p{S}`;
6. retain letters, digits, and non-Latin characters.

An empty normalized string is never considered a strong transcript match.

No fuzzy ML similarity, embeddings, or external model is used.

## 8. Duplicate overlap utterance detection

A pair of utterances from adjacent chunks is a duplicate only when all conditions hold:

- their absolute time intervals overlap;
- each utterance lies at least partly in the shared chunk-overlap window;
- normalized non-empty text is exactly equal;
- absolute start timestamps differ by at most `1_500 ms`;
- absolute end timestamps differ by at most `1_500 ms`.

When a duplicate pair is found, the canonical utterance is selected deterministically:

1. prefer the earlier chunk order;
2. then lower local segment index;
3. then lexical chunk ID.

The duplicate from the later chunk is excluded from persisted transcript segments.

This rule prevents duplicate subtitle/timeline rows without rewriting transcript text.

## 9. Adjacent speaker stitching

A local speaker key is:

`{chunkId}:{speakerIndex}`

Only adjacent chunks may create direct stitching evidence. Transitive closure may then join speaker keys across multiple chunks.

### Strong evidence edge

A speaker edge between chunk N and chunk N+1 is created when at least one duplicate utterance pair links those local speaker keys.

For a candidate edge, calculate:

- `matchCount`: number of duplicate utterance pairs connecting the two local speaker keys;
- `matchedDurationMs`: sum of intersection durations for those duplicate pairs.

An edge qualifies only when:

- `matchCount >= 1`; and
- `matchedDurationMs >= 750 ms`.

### Conflict rule

For each local speaker key on each side of a boundary, determine its best candidate by this deterministic ordering:

1. larger `matchCount`;
2. larger `matchedDurationMs`;
3. lexical opposite local speaker key.

A merge is accepted only for a mutual-best pair and only when the best score is strictly stronger than the second-best score for both sides. If either side ties on the numeric score tuple `(matchCount, matchedDurationMs)`, no merge occurs for that speaker at that boundary.

This prevents one ambiguous local speaker from collapsing multiple real speakers.

### Union step

Accepted pairings are combined through a deterministic union-find. Canonical cluster ordering uses the earliest canonical transcript occurrence `(startMs, endMs, chunkOrder, localSegmentIndex)`, then lexical local speaker key.

## 10. Project-stable speaker IDs for a new run

For a first processing run with no reusable speaker history, each diarized cluster receives:

`spk_{stableHash(projectId + ':' + canonicalLocalSpeakerKey)}`

The existing FNV-1a-style stable hash already used in ASR normalization is sufficient because the identifier is an internal deterministic key, not a security token.

The canonical local speaker key is selected from the cluster using the earliest canonical utterance ordering defined above. Therefore identical inputs produce identical speaker IDs.

Undiarized observations keep `speakerId = null`.

## 11. Rerun reconciliation with existing speakers

The processing workflow must load the current persisted segment-to-speaker assignments before replacing ASR segments.

Existing history is represented as:

```ts
export type ExistingSpeakerCoverage = {
  speakerId: string;
  ranges: Array<{ startMs: number; endMs: number }>;
};
```

For each newly stitched cluster, compute overlap duration against each existing speaker's historical ranges.

A historical speaker is reusable only when:

- total temporal intersection with the cluster is at least `2_000 ms`;
- it is the unique highest-overlap existing speaker for the cluster;
- the same existing speaker is not the unique highest-overlap candidate for another new cluster with an equal or higher overlap score.

If reconciliation is ambiguous, the new cluster keeps its deterministic new-run ID rather than stealing an existing ID.

Reused speaker IDs allow the existing `INSERT ... ON CONFLICT(id) DO NOTHING` speaker persistence behavior to preserve display names, ElevenLabs `voice_id`, `voice_provider`, and avatar metadata.

No old speaker row is deleted in Phase 4A. Orphan cleanup remains out of scope.

## 12. Segment identity

Segment IDs remain deterministic from project, chunk/local segment position, and absolute timing as today. Overlap duplicates are removed before persistence.

Phase 4A does not attempt to make segment IDs stable across arbitrary provider transcript changes. Speaker identity stability is the target, not transcript-row identity stability.

## 13. Pipeline changes

The dubbing workflow changes in this order:

1. authorize project;
2. load job/retry generation;
3. probe media;
4. extract overlapping audio chunks;
5. transcribe every chunk exactly as before;
6. load existing segment speaker coverage before destructive ASR replacement;
7. stitch/dedupe all ASR observations;
8. reconcile new speaker clusters with existing coverage;
9. replace persisted ASR segments using final `speakerId` values;
10. translate persisted segments;
11. finish in `needs_review`.

Cancellation checks remain before each expensive stage.

The pipeline must not mutate existing transcript/speaker state until all ASR calls required for stitching have completed successfully.

## 14. Usage accounting

Phase 3B `usage_events` remains authoritative.

ASR accounting continues to use each actual chunk's `durationMs / 1000` as provider units. Because overlap audio is intentionally sent twice to the provider, overlap seconds are legitimately included twice in `asr_audio_second` usage.

No credit refunds, overlap discounts, inferred unique-audio accounting, new usage kinds, or pricing logic are introduced.

Translation, TTS, and render accounting remain unchanged.

## 15. Telemetry

Phase 3C telemetry remains bounded and payload-free.

No transcript text, normalized transcript text, voice identity material, API keys, or new biometric data is written to Analytics Engine or logs.

Phase 4A may add only non-content operational fields through existing bounded telemetry events if needed, such as operation names. It does not require a new Analytics Engine dataset or schema expansion.

## 16. Error and fallback behavior

- malformed chunk overlap metadata -> `MEDIA_PROCESSOR_RESPONSE_INVALID`;
- malformed ASR ranges/indexes -> existing ASR normalization errors;
- ambiguous duplicate match -> do not dedupe unless exact duplicate contract passes;
- ambiguous speaker match -> do not merge;
- ambiguous rerun historical match -> do not reuse historical speaker ID;
- Workers AI ASR without `speakerIndex` -> persist `speakerId = null`;
- no overlap speech -> adjacent speaker identities remain separate;
- provider failure -> existing workflow failure semantics remain unchanged.

Phase 4A prefers false negatives (extra speaker rows) over false-positive speaker merges.

## 17. Security and privacy

Phase 4A stores no voice embedding, biometric template, voiceprint, face data, or new secret.

All speaker identifiers remain project-scoped internal identifiers. They must not be used to identify a person across projects.

No source transcript text is added to telemetry.

## 18. UI behavior

No new major Studio surface is required for Phase 4A.

Existing SpeakerList and ScriptInspector automatically benefit from fewer duplicate AI speakers because final persisted `speakerId` values are more stable. Existing manual speaker naming and voice selection continue to work.

A rerun that safely reuses a speaker ID must preserve its existing UI display name and selected voice. Ambiguous reruns may produce an additional AI speaker instead of silently merging it into a named character.

## 19. Tests and acceptance

### Media tests

- overlap constants generate starts at 0, 285s, 570s for 300s nominal chunks;
- first/interior/last overlap metadata is valid;
- Worker rejects malformed overlap metadata;
- object-key project scoping remains enforced.

### Stitching unit tests

- identical utterance in adjacent overlap dedupes to one canonical segment;
- one speaker whose local index changes across a boundary becomes one project speaker;
- two speakers with independent overlap utterances remain two speakers;
- numeric-score tie remains unmerged;
- no shared speech remains unmerged;
- empty/punctuation-only text never creates an edge;
- same input order-independent normalization produces deterministic output;
- undiarized segments keep `speakerId = null`.

### Rerun tests

- unique temporal coverage reuses existing speaker ID;
- reused ID preserves existing display name/voice because speaker insert conflicts are ignored;
- ambiguous historical coverage does not reuse an ID;
- two new clusters cannot both claim one existing speaker ID.

### Pipeline tests

- all ASR chunks complete before destructive segment replacement;
- existing speaker coverage is loaded before replacement;
- stitched IDs are what reach `replaceFromAsr`;
- Phase 3B ASR usage records actual overlapped chunk durations;
- cancellation and provider telemetry behavior remain intact.

### Regression gates

- complete Vitest suite;
- root deploy/config/Phase 3B/Phase 3C acceptance tests;
- TypeScript worker/app builds;
- Wrangler dry-run;
- existing CJK/reference screenshot gate.

## 20. Files and module boundaries

Expected focused modules:

- `worker/src/services/asr/stitch.ts` — duplicate detection, local-speaker graph, deterministic clustering;
- `worker/src/services/asr/reconcile.ts` — reconciliation of new clusters to existing persisted speaker coverage;
- `worker/src/services/asr/normalize.ts` — absolute observation construction / stable segment normalization integration;
- `worker/src/services/media/types.ts` — overlap metadata contract;
- `worker/src/services/media/container.ts` — validate container overlap metadata;
- `containers/ffmpeg/server.mjs` — overlapping extraction implementation;
- `worker/src/db/segments.ts` — read existing speaker coverage and persist final stitched IDs;
- `worker/src/workflows/pipeline.ts` — orchestration only.

The stitching/reconciliation algorithms must remain pure and independently unit-testable. Provider and D1 concerns must not be embedded in them.

## 21. Migration policy

No D1 schema migration is required for Phase 4A.

The existing `speakers.id` and `segments.speaker_id` columns are sufficient. This deliberately minimizes persistence risk and lets speaker continuity improve without invalidating existing projects.

## 22. Rollout and compatibility

Existing projects remain readable without migration.

Processing a project again may create project-stable IDs for newly observed clusters or reuse old IDs when reconciliation evidence is unique. Existing old chunk-scoped speaker rows may remain orphaned; they are harmless and not cleaned automatically in this phase.

The feature is source-compatible with Workers AI fallback and current editor APIs.

## 23. Production qualification

Source/CI completion does not equal production runtime qualification.

The existing Cloudflare Container credential and real provider/media fixture blocker remains separate. Phase 4A must not claim `yupvox.qs3d.site` production runtime PASS unless that external qualification is independently completed with real runtime evidence.

## 24. Success criteria

Phase 4A is complete when:

1. FFmpeg produces validated overlapping chunks with the fixed 15-second boundary overlap;
2. duplicated ASR utterances in shared overlap are persisted once;
3. strong unambiguous adjacent overlap evidence merges local Deepgram speaker indexes into one project speaker;
4. ambiguous evidence never forces a merge;
5. deterministic inputs produce deterministic speaker IDs;
6. safe reruns reuse old speaker IDs and therefore preserve existing speaker name/voice assignments;
7. Workers AI fallback remains valid without diarization;
8. Phase 3B usage accounting charges actual provider-processed overlap seconds without changing ledger semantics;
9. all existing Phase 3B/3C and Studio regression gates remain GREEN;
10. the exact Phase 4A PR head and post-merge `main` are fully GREEN before Phase 4A is called complete.
