# YupVox Phase 4A — Cross-Chunk Speaker Stitching Design

Date: 2026-09-06
Status: Approved continuation of the repository Phase 4 roadmap

## 1. Goal

Upgrade the existing Deepgram diarization path from deliberately chunk-scoped speaker identities to conservative cross-chunk speaker stitching without pretending that a speaker match is known when evidence is weak.

Phase 4A is source/CI qualification only. It must not deploy production, change the manual-only production deployment boundary, or claim production diarization PASS.

## 2. Current boundary

The existing media processor emits non-overlapping 5-minute WAV chunks. Deepgram returns speaker indexes that are local to one request. `normalizeAsrChunks` therefore hashes `(projectId, chunkId, speakerIndex)` into a chunk-scoped speaker ID. The deployment status explicitly says the same speaker index in different chunks is not assumed to be the same person.

That behavior is truthful but causes one real person to appear as multiple speakers in long media.

## 3. Chosen approach

Use a small deterministic audio overlap between adjacent ASR chunks, then stitch identities only from duplicate utterances observed in the shared overlap window.

The media processor will emit 300-second analysis windows with an 8-second overlap. Adjacent offsets therefore advance by 292 seconds. Every window remains bounded to at most 300 seconds.

The stitching layer will:

1. convert chunk-local timestamps to global project timestamps;
2. identify duplicate utterances in adjacent overlap windows using both timing and normalized text;
3. use duplicate diarized utterances as evidence that one local speaker in the left chunk corresponds to one local speaker in the right chunk;
4. accept only unambiguous one-to-one speaker mappings;
5. union accepted local identities across the project;
6. derive a deterministic project-scoped speaker ID from the canonical member of each accepted identity set;
7. remove duplicate overlap utterances from the persisted transcript;
8. retain the original chunk-scoped identity whenever there is insufficient or ambiguous evidence.

This is deliberately conservative. A false split is preferable to a false merge.

## 4. Match rules

Two utterances from adjacent overlapping chunks are duplicate candidates only when all of the following hold:

- both intersect the actual chunk overlap interval;
- normalized text is non-empty and equal after Unicode normalization, trim, whitespace collapse, and locale-independent lowercasing;
- their global start times differ by at most 1,500 ms;
- their global end times differ by at most 1,500 ms;
- their temporal intersection is at least 50% of the shorter utterance duration.

A diarized speaker mapping is accepted only when the duplicate evidence for a local speaker points to exactly one local speaker on the adjacent chunk and the reverse mapping is also unique. Ambiguous mappings are not merged.

No text similarity model, LLM, speaker-index coincidence, name heuristic, or guessed acoustic identity is allowed.

## 5. Deterministic identity

Each local diarized identity is represented as:

`<chunkId>:<speakerIndex>`

Accepted mappings form disjoint sets. The canonical identity for a set is the lexicographically smallest local identity key. The persisted speaker ID is a stable hash of:

`<projectId>:<canonical-local-identity>`

A local identity with no accepted mapping remains a singleton set and therefore retains deterministic chunk-scoped behavior.

## 6. Duplicate handling

Overlap exists only for analysis quality and stitching evidence. Duplicate utterances must not be persisted twice.

For a matched duplicate pair, keep the earlier chunk's utterance as the canonical segment. Its stable segment ID remains derived from its own chunk/index/global range, preserving deterministic retries. The later duplicate is discarded before `replaceFromAsr`.

Non-duplicate utterances in either side of the overlap remain untouched.

Workers AI Whisper does not provide `speakerIndex`. It still benefits from the same overlap duplicate suppression, but no speaker identities are invented.

## 7. Media extraction

`ContainerMediaProcessor.extractAudioChunks` requests:

- `chunkSeconds: 300`
- `overlapSeconds: 8`

The FFmpeg container validates `overlapSeconds` as an integer from 0 through 30 and strictly less than `chunkSeconds`.

Instead of FFmpeg's segment muxer, the container extracts bounded windows from the already-downloaded source with explicit start/duration arguments. Window start is `index * (chunkSeconds - overlapSeconds)` and extraction stops when start reaches the source duration.

Returned `offsetMs` is the true analysis-window start, not `index * chunkSeconds`.

## 8. Usage accounting

Phase 3B usage accounting remains authoritative. ASR usage records the actual returned chunk duration, including overlap seconds, because the provider receives and processes those seconds.

Phase 4A must not alter credit balances, pricing, quota enforcement, or rate-limit semantics.

## 9. Failure and safety behavior

- malformed chunk ranges still fail closed;
- malformed speaker indexes still fail closed;
- overlap configuration outside the allowed range fails closed;
- ambiguous speaker evidence does not fail the workflow; it simply leaves identities unmerged;
- duplicate suppression never matches on text alone without temporal agreement;
- no provider secrets, transcript payloads, or bearer data are added to telemetry;
- production deployment remains manual-only and is not executed as part of Phase 4A.

## 10. Files and responsibilities

- `containers/ffmpeg/server.mjs`: bounded overlapping audio-window extraction.
- `worker/src/services/media/container.ts`: request the canonical overlap.
- `worker/src/services/asr/stitch.ts`: pure cross-chunk duplicate detection, conservative speaker union, deterministic speaker IDs.
- `worker/src/services/asr/normalize.ts`: keep low-level per-chunk normalization primitives and delegate project stitching at a clear boundary.
- `worker/src/workflows/pipeline.ts`: use stitched normalized segments before persistence.
- `worker/test/asr.test.ts`: algorithm unit tests.
- `worker/test/media-processor.test.ts` or the existing media processor test surface: request/validation contract.
- `tests/phase4a-speaker-stitching-acceptance.test.mjs`: source-level safety/qualification gate.
- `package.json`: include Phase 4A acceptance in `verify:deploy-config`.
- `README.md` and `docs/deployment-status.md`: truthfully describe source-qualified stitching while retaining runtime UNQUALIFIED.

## 11. Acceptance criteria

Phase 4A source qualification requires all of the following:

1. adjacent ASR chunks have an 8-second overlap while each window remains <= 300 seconds;
2. offsets use the true stride and remain monotonic;
3. duplicate overlap utterances are persisted once;
4. confident one-to-one duplicate evidence produces the same project speaker ID across chunk boundaries;
5. ambiguous many-to-one or one-to-many evidence never merges speakers;
6. no-overlap/no-evidence cases retain deterministic chunk-scoped identities;
7. non-diarized ASR deduplicates overlap without inventing speakers;
8. existing segment timing and stable ID behavior remains deterministic;
9. Phase 3B usage accounting continues to use actual processed ASR seconds;
10. complete tests, typecheck, Vite build, Wrangler dry-run, and Phase 4A acceptance are GREEN on the exact feature head;
11. no production deployment is triggered;
12. docs continue to label production runtime UNQUALIFIED until real deployed provider/media fixtures pass.

## 12. Deferred Phase 4 work

Not part of 4A:

- acoustic speaker embeddings or external speaker-recognition providers;
- voice cloning;
- source-background/dialogue separation;
- visual lip-sync;
- glossary/style presets;
- batch/multi-language export.

Those remain separate Phase 4 lanes so each can be reviewed and qualified independently.
