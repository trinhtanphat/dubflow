# Project-Stable Diarization Reconciliation Design

Date: 2026-09-06
Status: Approved continuation after concurrent Phase 4 merges

## Goal

Reconcile the already-merged cross-chunk speaker stitching lane with the previously approved project-stable diarization contract, without reverting or duplicating the concurrently merged glossary/style translation-context work.

The live `main` already has bounded overlapping ASR windows, overlap transcript deduplication, conservative one-to-one cross-chunk speaker stitching, contextual translation, and migration `0007_translation_context.sql`. This reconciliation adds only the residual diarization guarantees that are still missing.

## Preserve from live main

- Cloudflare-first Worker/Workflow/Container architecture.
- Deepgram Nova-3 diarized ASR and Workers AI Whisper fallback.
- `containers/ffmpeg/audio-windows.mjs` as the media-window helper.
- Project-scoped chunk object keys and true `offsetMs` values.
- Cross-chunk duplicate suppression and deterministic speaker hashing.
- Translation-context migration `0007_translation_context.sql` and all glossary/style behavior.
- Phase 3B usage accounting, Phase 3C telemetry/rate limiting/sharing, cancellation, and failure semantics.

## Residual changes

### 1. Canonical overlap

The production Worker requests 300-second windows with a fixed 15-second overlap. `audio-windows.mjs` remains generic for validation/tests, but the production request is pinned to:

```ts
chunkSeconds: 300,
overlapSeconds: 15,
```

The resulting interior stride is 285 seconds. ASR usage continues to count actual returned chunk duration, including duplicated overlap seconds processed by the provider.

### 2. Stronger deterministic duplicate and speaker evidence

Text matching uses deterministic Unicode normalization:

1. NFKC;
2. trim;
3. deterministic Latin case folding through `toLocaleLowerCase('en-US')`;
4. collapse Unicode whitespace to one ASCII space;
5. remove Unicode punctuation and symbol characters (`\p{P}` / `\p{S}`);
6. reject an empty normalized string as evidence.

Duplicate utterance detection remains adjacent-chunk and time-bounded. A duplicate pair may still be suppressed from the transcript when it satisfies duplicate rules.

A cross-chunk speaker edge is stronger than duplicate suppression: it requires at least one qualifying duplicate pair and at least 750 ms of total matched temporal intersection for that local-speaker pair.

For each boundary, candidate speaker edges are ranked by:

1. larger duplicate `matchCount`;
2. larger `matchedDurationMs`;
3. lexical opposite local-speaker key only as deterministic ordering, never as evidence.

A speaker merge is accepted only when each side is the other's unique numeric best. A numeric tie on either side fails closed and leaves the identities separate.

### 3. Historical rerun reconciliation

After all ASR provider calls complete, but before destructive `replaceFromAsr`, the workflow loads the project's current persisted segments and groups non-null speaker assignments into historical temporal coverage:

```ts
export type ExistingSpeakerCoverage = {
  speakerId: string;
  ranges: Array<{ startMs: number; endMs: number }>;
};
```

Each newly stitched speaker cluster is scored against historical speakers by summed temporal intersection.

A historical speaker ID may be reused only when:

- total overlap is at least 2,000 ms;
- it is the unique highest-overlap historical speaker for that new cluster;
- one historical speaker cannot be claimed by multiple new clusters when the competition is ambiguous or equal/stronger.

Ambiguous history never forces reuse. The fresh deterministic stitched ID is retained instead.

The existing `INSERT INTO speakers ... ON CONFLICT(id) DO NOTHING` behavior remains the preservation mechanism for existing display names, avatar metadata, `voice_provider`, and ElevenLabs `voice_id` when a historical ID is safely reused.

## No new schema or biometric identity

This reconciliation adds no D1 migration. Migration `0007_translation_context.sql` is legitimate existing translation-context state and remains untouched.

No speaker embedding, voiceprint, biometric template, cross-project identity, or voice-cloning data is introduced. Reconciliation uses only project-local persisted segment timing and speaker IDs.

## Pipeline order

The required order is:

1. authorize project;
2. load durable job/retry generation;
3. probe source;
4. extract overlapping chunks;
5. complete all ASR calls and Phase 3B ASR usage writes;
6. load existing speaker coverage;
7. stitch/dedupe current ASR observations;
8. reconcile current clusters with historical speaker IDs;
9. replace persisted ASR segments;
10. load the translation-context snapshot and translate exactly as current main does;
11. finish `needs_review`.

No existing transcript state is destructively replaced until all ASR calls required for the run have succeeded.

## TDD acceptance

Tests must prove:

- production media request uses `300 / 15` and 285-second stride;
- punctuation/case variants in the same overlap dedupe deterministically;
- a short duplicate below 750 ms may dedupe but does not stitch speaker identity;
- tied speaker evidence remains unmerged;
- unique historical coverage >=2s reuses the old speaker ID;
- ambiguous historical coverage does not reuse;
- two new clusters cannot steal one historical ID;
- pipeline loads history after ASR and before replacement;
- reused ID preserves existing custom speaker name/ElevenLabs voice through conflict-ignore persistence;
- Workers AI undiarized segments never gain invented speaker IDs;
- `chunk.durationMs / 1000` remains the ASR usage unit;
- translation-context behavior and migration 0007 remain intact;
- production runtime remains **UNQUALIFIED**.

## Production boundary

This is source/CI reconciliation only. It does not deploy production and does not qualify the Cloudflare Container or real Deepgram/provider-media fixtures. Production runtime remains **UNQUALIFIED** until those external gates pass.
