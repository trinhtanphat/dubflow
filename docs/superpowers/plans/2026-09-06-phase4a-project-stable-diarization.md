# Phase 4A Project-Stable Diarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make diarized speakers stable across bounded ASR chunks and safe reruns using 15-second adjacent-chunk overlap, deterministic deduplication, conservative speaker stitching, and temporal reconciliation to existing speaker IDs.

**Architecture:** Keep Deepgram/Workers AI provider adapters unchanged. Extend the FFmpeg chunk contract with overlap metadata, add pure ASR `stitch` and `reconcile` modules, and let the workflow orchestrate existing history -> ASR observations -> stitched clusters -> reused/fresh speaker IDs -> existing persistence. No D1 migration, biometric embedding, or billing semantic change.

**Tech Stack:** TypeScript, Vitest, Node.js FFmpeg container, Cloudflare Workers/Workflows/R2/D1, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4a-project-stable-diarization-design.md`

## Global Constraints

- Nominal audio chunk length is exactly `300_000 ms`.
- Adjacent overlap is exactly `15_000 ms`; chunk step is `285_000 ms`.
- Duplicate transcript matching requires exact normalized non-empty text and <= `1_500 ms` start/end deltas.
- Speaker merge requires at least one duplicate pair and `matchedDurationMs >= 750`.
- Ambiguous/tied speaker evidence must remain unmerged.
- Existing speaker ID reuse requires unique temporal overlap of at least `2_000 ms`.
- Workers AI undiarized segments keep `speakerId = null`.
- Phase 3B `usage_events` remains accounting source-of-truth and counts actual provider-processed overlap seconds.
- No biometric embeddings, voiceprints, voice cloning, source separation, lip-sync, payment/quota changes, or production-runtime qualification.
- Production runtime remains UNQUALIFIED until the separate Cloudflare Container/live-fixture blocker is resolved.

---

### Task 1: Overlapping media chunk contract

**Files:**
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/server.mjs`
- Test: `worker/test/media-container.test.ts`
- Create: `containers/ffmpeg/audio-chunks.mjs`
- Create: `containers/ffmpeg/audio-chunks.test.mjs`

**Interfaces:**
- Produces: `AudioChunk` with `overlapBeforeMs` and `overlapAfterMs`.
- Produces: pure `buildAudioChunkWindows(durationMs, chunkMs = 300_000, overlapMs = 15_000)` for deterministic window tests.
- Consumes later: pipeline uses returned `AudioChunk` metadata without re-deriving overlap.

- [ ] **Step 1: Write failing window tests**

Create `containers/ffmpeg/audio-chunks.test.mjs` asserting:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioChunkWindows } from './audio-chunks.mjs';

test('uses 300s windows with 15s overlap', () => {
  const windows = buildAudioChunkWindows(900_000);
  assert.deepEqual(windows.map((w) => w.offsetMs), [0, 285_000, 570_000, 855_000]);
  assert.equal(windows[0].overlapBeforeMs, 0);
  assert.equal(windows[0].overlapAfterMs, 15_000);
  assert.equal(windows[1].overlapBeforeMs, 15_000);
  assert.equal(windows.at(-1).overlapAfterMs, 0);
});

test('rejects overlap greater than or equal to chunk length', () => {
  assert.throws(() => buildAudioChunkWindows(60_000, 30_000, 30_000));
});
```

- [ ] **Step 2: Run the focused container tests and verify RED**

Run: `node --test containers/ffmpeg/audio-chunks.test.mjs`

Expected: FAIL because `audio-chunks.mjs` does not exist.

- [ ] **Step 3: Implement pure window generation**

Create `containers/ffmpeg/audio-chunks.mjs` with:

```js
export const AUDIO_CHUNK_MS = 300_000;
export const AUDIO_CHUNK_OVERLAP_MS = 15_000;

export function buildAudioChunkWindows(durationMs, chunkMs = AUDIO_CHUNK_MS, overlapMs = AUDIO_CHUNK_OVERLAP_MS) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('durationMs must be positive.');
  if (!Number.isInteger(chunkMs) || chunkMs <= 0) throw new Error('chunkMs must be a positive integer.');
  if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs >= chunkMs) throw new Error('overlapMs must be smaller than chunkMs.');
  const stepMs = chunkMs - overlapMs;
  const out = [];
  for (let offsetMs = 0; offsetMs < durationMs; offsetMs += stepMs) {
    const windowDurationMs = Math.min(chunkMs, durationMs - offsetMs);
    const hasPrevious = offsetMs > 0;
    const hasNext = offsetMs + windowDurationMs < durationMs;
    out.push({
      offsetMs,
      durationMs: windowDurationMs,
      overlapBeforeMs: hasPrevious ? Math.min(overlapMs, windowDurationMs) : 0,
      overlapAfterMs: hasNext ? Math.min(overlapMs, windowDurationMs) : 0,
    });
  }
  return out;
}
```

- [ ] **Step 4: Replace segment mux extraction with explicit bounded windows**

In `containers/ffmpeg/server.mjs`, import the constants/window builder. Probe source duration once, iterate the returned windows, and invoke FFmpeg per window with project-relative `-ss` and `-t` values. Upload each WAV to the existing `projects/{projectId}/audio/{index}.wav` key and return the exact window metadata plus measured WAV duration.

The response item must be:

```js
{
  objectKey,
  offsetMs: window.offsetMs,
  durationMs: await durationMs(filePath),
  overlapBeforeMs: window.overlapBeforeMs,
  overlapAfterMs: window.overlapAfterMs,
}
```

- [ ] **Step 5: Extend Worker `AudioChunk` and validation**

In `worker/src/services/media/types.ts`:

```ts
export type AudioChunk = {
  objectKey: string;
  offsetMs: number;
  durationMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
};
```

In `ContainerMediaProcessor.extractAudioChunks`, validate both overlap fields as non-negative integers and reject values larger than `durationMs` with `MEDIA_PROCESSOR_RESPONSE_INVALID`.

- [ ] **Step 6: Add Worker contract tests**

Extend `worker/test/media-container.test.ts` so a valid fake container response with overlap fields passes, and malformed/missing overlap metadata fails closed.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
node --test containers/ffmpeg/audio-chunks.test.mjs containers/ffmpeg/render-export.test.mjs
npm test -- --run worker/test/media-container.test.ts
```

Expected: PASS.

Commit: `feat: add overlapping ASR audio chunks`

---

### Task 2: Pure overlap deduplication and speaker stitching

**Files:**
- Create: `worker/src/services/asr/stitch.ts`
- Create: `worker/test/asr-stitch.test.ts`
- Modify: `worker/src/services/asr/normalize.ts`
- Modify: `worker/test/asr.test.ts`

**Interfaces:**
- Produces: `DiarizedObservation`, `StitchedAsrSegment`, `stitchAsrChunks(chunks)`.
- `stitchAsrChunks` returns canonical non-duplicate segments with deterministic fresh project speaker IDs or `null` for undiarized observations.
- Task 3 consumes the stitched segment list and may replace its fresh IDs with historical IDs.

- [ ] **Step 1: Write failing stitching tests**

Create tests covering:

```ts
it('dedupes the same overlap utterance and stitches changed local speaker indexes', () => {
  const result = stitchAsrChunks([
    chunk('p1', 'c0', 0, 0, 15_000, [{ startMs: 290_000, endMs: 295_000, text: 'Hello!', speakerIndex: 0 }]),
    chunk('p1', 'c1', 285_000, 15_000, 15_000, [{ startMs: 5_000, endMs: 10_000, text: 'hello', speakerIndex: 2 }]),
  ]);
  expect(result).toHaveLength(1);
  expect(result[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
});
```

Also add explicit tests for two independent speakers, tied evidence, no shared speech, punctuation-only text, input-order determinism, and undiarized `speakerId: null`.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm test -- --run worker/test/asr-stitch.test.ts`

Expected: FAIL because `stitch.ts` does not exist.

- [ ] **Step 3: Implement observation conversion and normalization helpers**

In `stitch.ts`, define:

```ts
export type StitchChunk = {
  projectId: string;
  chunkId: string;
  chunkOrder: number;
  offsetMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
  segments: AsrSegment[];
};

export type StitchedAsrSegment = {
  id: string;
  projectId: string;
  chunkId: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerIndex?: number;
  speakerId: string | null;
};
```

Use Unicode NFKC, trim/collapse whitespace, `toLocaleLowerCase('en-US')`, then remove `\p{P}` and `\p{S}` with Unicode regexes. Export the text normalizer only if tests need it; otherwise keep it module-private.

- [ ] **Step 4: Implement duplicate pair discovery**

Sort chunks by `(offsetMs, chunkId)` and segments by absolute `(startMs, endMs, localIndex)`. Compare only adjacent chunks whose windows overlap. A duplicate requires non-empty exact normalized text, interval overlap, and <=1500ms start/end deltas.

Keep the earlier chunk/local-index observation as canonical and record duplicate pair speaker evidence before dropping the later observation.

- [ ] **Step 5: Implement conservative mutual-best stitching**

Aggregate evidence by boundary and local speaker pair into `{matchCount, matchedDurationMs}`. Require `matchedDurationMs >= 750`. Accept only mutual-best numeric score pairs with no numeric tie on either side. Union accepted local speaker keys deterministically.

Fresh speaker IDs use:

```ts
`spk_${stableHash(`${projectId}:${canonicalLocalSpeakerKey}`)}`
```

Move/export `stableHash` from `normalize.ts` into `stitch.ts` or a small shared helper only if necessary; do not duplicate different hash implementations.

- [ ] **Step 6: Keep legacy `normalizeAsrChunks` compatible**

Update `normalize.ts` so existing callers/tests without overlap metadata continue to work. Remove chunk-scoped speaker-ID generation from the production pipeline path; compatibility tests may still call normal normalization for undiarized/basic timing behavior.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm test -- --run worker/test/asr-stitch.test.ts worker/test/asr.test.ts
```

Expected: PASS.

Commit: `feat: stitch diarized speakers across chunk overlap`

---

### Task 3: Pure rerun reconciliation

**Files:**
- Create: `worker/src/services/asr/reconcile.ts`
- Create: `worker/test/asr-reconcile.test.ts`

**Interfaces:**
- Consumes: `StitchedAsrSegment[]` from Task 2.
- Produces: `ExistingSpeakerCoverage`, `reconcileSpeakerIds(stitched, existingCoverage)` returning the same segment shape with only safe historical ID substitutions.

- [ ] **Step 1: Write failing reconciliation tests**

Cover unique reuse, <2000ms non-reuse, tied historical coverage, and two new clusters competing for one existing speaker.

Example:

```ts
it('reuses one unique historical speaker with at least 2s overlap', () => {
  const out = reconcileSpeakerIds(newSegments('spk_fresh', [[10_000, 14_000]]), [
    { speakerId: 'spk_existing', ranges: [{ startMs: 9_000, endMs: 14_000 }] },
  ]);
  expect(out[0].speakerId).toBe('spk_existing');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run worker/test/asr-reconcile.test.ts`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement coverage scoring**

For each fresh speaker cluster, sum temporal interval intersections against each existing speaker. Require >=2000ms and a unique maximum. Resolve global competition so one existing speaker ID can be claimed by at most one new cluster; when equal-or-stronger competing claims exist, neither ambiguous claimant steals the ID.

- [ ] **Step 4: Guarantee deterministic output**

Sort speaker IDs and cluster IDs before tie resolution. Do not depend on input array ordering.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- --run worker/test/asr-reconcile.test.ts`

Expected: PASS.

Commit: `feat: reconcile diarization with existing speakers`

---

### Task 4: Pipeline integration and speaker preservation

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`
- Modify: `worker/test/asr-persistence.test.ts`
- Modify: `worker/test/speaker-persistence.test.ts`

**Interfaces:**
- `PipelineSegments` adds existing `list(projectId, userId)` from `SegmentStore`.
- Pipeline passes each `AudioChunk` overlap field to `stitchAsrChunks`.
- Pipeline builds `ExistingSpeakerCoverage[]` from pre-replacement segment rows, calls `reconcileSpeakerIds`, then passes final IDs to `replaceFromAsr`.

- [ ] **Step 1: Write RED pipeline tests**

Add a workflow test where two overlapping chunks contain the same utterance but different local `speakerIndex`; expect one persisted segment and one final speaker ID. Assert `segments.list` happens after all ASR transcriptions and before `replaceFromAsr`.

Add a rerun test where existing segments reference `spk_existing`; expect `replaceFromAsr` receives that ID when new coverage uniquely overlaps it.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- --run worker/test/dubbing-workflow.test.ts worker/test/asr-persistence.test.ts worker/test/speaker-persistence.test.ts
```

Expected: new assertions FAIL while legacy tests remain green.

- [ ] **Step 3: Build existing coverage without schema changes**

Use `deps.segments.list(params.projectId, params.userId)` before replacement. Group rows with non-null `speakerId` into:

```ts
{ speakerId, ranges: [{ startMs, endMs }] }
```

No new D1 query or migration is needed unless test evidence shows the generic list path cannot satisfy ordering/performance requirements.

- [ ] **Step 4: Replace normalization path**

After all ASR calls finish, create stitch chunks using each media chunk's `offsetMs`, `overlapBeforeMs`, and `overlapAfterMs`. Call `stitchAsrChunks`, then `reconcileSpeakerIds`, then map into the existing `PersistedAsrSegment` shape for `replaceFromAsr`.

- [ ] **Step 5: Preserve usage and telemetry semantics**

Do not change ASR usage units: keep `chunk.durationMs / 1000`. Keep existing started/completed idempotency keys, provider telemetry wrapper, cancellation checks, and failure codes.

- [ ] **Step 6: Prove speaker metadata survives ID reuse**

Extend persistence tests with an existing `speakers` row containing custom `display_name`, `voice_provider='elevenlabs'`, and `voice_id`. Call `replaceFromAsr` with the same ID and assert the speaker metadata is not overwritten while new segment rows reference it.

- [ ] **Step 7: Run focused + adjacent tests and commit**

Run:

```bash
npm test -- --run worker/test/dubbing-workflow.test.ts worker/test/asr-persistence.test.ts worker/test/speaker-persistence.test.ts worker/test/provider-telemetry-workflows.test.ts worker/test/usage.test.ts
```

Expected: PASS.

Commit: `feat: persist project-stable diarized speakers`

---

### Task 5: Phase 4A safety acceptance and deployment status

**Files:**
- Create: `tests/phase4a-diarization-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- Adds source-level regression gate to `verify:deploy-config`.
- Documents source/CI completion only; production runtime remains UNQUALIFIED.

- [ ] **Step 1: Write acceptance test first**

The root test must assert source contracts rather than duplicate unit implementation details:

```js
const stitch = read('worker/src/services/asr/stitch.ts');
const reconcile = read('worker/src/services/asr/reconcile.ts');
const media = read('worker/src/services/media/types.ts');
const pipeline = read('worker/src/workflows/pipeline.ts');

assert.match(media, /overlapBeforeMs/);
assert.match(media, /overlapAfterMs/);
assert.match(stitch, /1_500|1500/);
assert.match(stitch, /750/);
assert.match(reconcile, /2_000|2000/);
assert.doesNotMatch(stitch + reconcile, /embedding|voiceprint|biometric/i);
assert.match(pipeline, /chunk\.durationMs\s*\/\s*1000/);
```

Also assert no new migration `0007*` is required for Phase 4A and deployment status contains `Phase 4A` plus `UNQUALIFIED`.

- [ ] **Step 2: Wire acceptance into verification and observe RED for docs**

Append `node --test tests/phase4a-diarization-acceptance.test.mjs` to the existing `verify:deploy-config` command in `package.json`.

Run: `npm run verify:deploy-config`

Expected: FAIL only because deployment status does not yet record Phase 4A.

- [ ] **Step 3: Update deployment status**

Document:

- Phase 4A source contract;
- fixed 300s/15s overlap;
- conservative project-stable speaker stitching;
- safe rerun ID reuse preserving speaker voice/name mappings;
- no biometric embeddings or voice cloning;
- Phase 3B overlap usage accounting remains authoritative;
- production runtime remains UNQUALIFIED due the existing Container/live-fixture blocker.

- [ ] **Step 4: Run full local verification**

Run:

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: all tests/build/config checks PASS and Wrangler dry-run PASS.

- [ ] **Step 5: Commit**

Commit: `test: lock Phase 4A diarization safety contract`

---

### Task 6: Exact-head CI, PR, merge, and post-merge qualification

**Files:**
- No planned product-code changes; only residual fixes proven by fresh CI are allowed.

**Interfaces:**
- Produces: merged Phase 4A on `main` with exact-head and post-merge evidence.

- [ ] **Step 1: Qualify final carrier head**

Require one fresh workflow run on the exact carrier SHA with all existing jobs GREEN, including verify/tests/build, Wrangler dry-run, CJK/reference screenshot gate, and artifact upload.

- [ ] **Step 2: Re-read live `main` and reconcile safely**

Compare live `main` to carrier. If `main` advanced, perform only a non-force reconciliation and rerun exact-head CI. Never force-push over concurrent work.

- [ ] **Step 3: Open PR to `main`**

PR title: `feat: make diarized speakers project-stable`

PR body must summarize overlap/dedupe/stitch/reconcile contracts, usage preservation, no-biometric boundary, tests, and production-runtime caveat.

- [ ] **Step 4: Require PR-trigger exact-head GREEN**

Do not merge based only on branch-push CI. Verify PR head SHA equals the qualified SHA and PR-triggered full CI is GREEN.

- [ ] **Step 5: Race-check and merge with expected head**

Verify:

- PR is open and mergeable;
- no unresolved review thread;
- live `main` has not drifted from the qualified base;
- PR head is unchanged.

Merge with method `merge` and `expected_head_sha=<qualified SHA>`.

- [ ] **Step 6: Post-merge main qualification**

Verify `main` points to the returned merge commit and require a full post-merge CI run on that exact SHA to be GREEN before calling Phase 4A complete.

- [ ] **Step 7: Preserve production caveat**

Do not deploy or claim production runtime PASS. Keep Cloudflare production runtime UNQUALIFIED until the separate Container credential and live provider/media fixture qualification is completed.
