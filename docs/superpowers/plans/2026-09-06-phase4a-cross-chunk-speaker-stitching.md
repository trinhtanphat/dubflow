# Phase 4A Cross-Chunk Speaker Stitching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative, deterministic cross-chunk speaker stitching from overlapping ASR evidence while suppressing duplicate overlap utterances and preserving fail-closed chunk-scoped identities when evidence is ambiguous.

**Architecture:** FFmpeg emits bounded 300-second windows with an 8-second overlap. A pure ASR stitching module converts chunk-local ranges to project time, identifies duplicate utterances in adjacent overlaps, builds only unambiguous one-to-one speaker unions, derives deterministic speaker IDs, and removes duplicate overlap segments before persistence. Existing usage accounting records the real processed chunk durations, including overlap.

**Tech Stack:** TypeScript, Vitest, Node test runner, Cloudflare Worker/Workflow, Cloudflare Container + FFmpeg, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4a-cross-chunk-speaker-stitching-design.md`

## Global Constraints

- Production deployment remains manual-only; do not run `deploy-cloudflare.yml`.
- Production runtime remains UNQUALIFIED.
- Analysis windows are at most 300 seconds with exactly 8 seconds overlap.
- Speaker mappings require temporal + normalized-text duplicate evidence and must be one-to-one in both directions.
- Ambiguous evidence keeps identities separate.
- Workers AI/non-diarized ASR may deduplicate overlap but must never invent speakers.
- Phase 3B usage accounting remains authoritative and records actual provider-processed seconds.
- No pricing, quota, payment, voice cloning, acoustic speaker recognition, or lip-sync work is included.

---

### Task 1: Lock Phase 4A acceptance RED

**Files:**
- Create: `tests/phase4a-speaker-stitching-acceptance.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: repository source files as text.
- Produces: a `verify:deploy-config` gate that fails until overlap extraction, stitching module, pipeline integration, and truthful docs exist.

- [ ] **Step 1: Write the failing acceptance test**

Create a Node test that reads `worker/src/services/asr/stitch.ts`, `worker/src/services/media/container.ts`, `containers/ffmpeg/server.mjs`, `worker/src/workflows/pipeline.ts`, and `docs/deployment-status.md`, then asserts these contracts:

```js
assert.match(mediaClient, /overlapSeconds:\s*8/);
assert.match(containerServer, /overlapSeconds/);
assert.match(containerServer, /chunkSeconds\s*-\s*overlapSeconds/);
assert.match(stitch, /export function stitchAsrChunks/);
assert.match(stitch, /AMBIGUOUS|ambiguous|unique/i);
assert.match(pipeline, /stitchAsrChunks/);
assert.match(status, /Phase 4A/);
assert.match(status, /UNQUALIFIED/);
```

Also assert `package.json` includes this test in `verify:deploy-config`.

- [ ] **Step 2: Push only the test/package gate and verify RED**

Expected GitHub Actions result: `npm run verify:deploy-config` fails because `stitch.ts` and the new source contracts do not exist yet.

- [ ] **Step 3: Record exact RED evidence**

Capture exact branch head SHA, workflow run ID, job ID, and the first Phase 4A assertion failure. Do not write production code until this RED is observed.

---

### Task 2: Emit bounded overlapping audio windows

**Files:**
- Modify: `worker/src/services/media/container.ts`
- Modify: `containers/ffmpeg/server.mjs`
- Create or modify: `worker/test/media-processor.test.ts`

**Interfaces:**
- Consumes: `MediaProcessor.extractAudioChunks(projectId, objectKey)`.
- Produces: `AudioChunk[]` where every chunk has the true analysis start in `offsetMs`, duration <= 300000 ms, and adjacent windows normally advance by 292000 ms.

- [ ] **Step 1: Write failing Worker-side request test**

Test a fake Container stub and assert the request body is:

```ts
expect(JSON.parse(body)).toEqual({
  projectId: 'p1',
  objectKey: 'projects/p1/source/original.mp4',
  chunkSeconds: 300,
  overlapSeconds: 8,
});
```

- [ ] **Step 2: Verify the focused Vitest fails**

Run via CI or local equivalent:

```bash
npx vitest run worker/test/media-processor.test.ts
```

Expected: FAIL because `overlapSeconds` is absent.

- [ ] **Step 3: Add the canonical overlap request**

In `ContainerMediaProcessor.extractAudioChunks`, send:

```ts
chunkSeconds: 300,
overlapSeconds: 8,
```

Keep response validation unchanged except that offsets are no longer assumed to be `index * 300000`.

- [ ] **Step 4: Add container extraction contract tests before implementation**

Extract a pure helper from `containers/ffmpeg/server.mjs` if needed, for example:

```js
export function buildAudioWindows(durationMs, chunkSeconds, overlapSeconds) {
  // implementation follows after RED
}
```

Test:

```js
assert.deepEqual(buildAudioWindows(610000, 300, 8), [
  { offsetMs: 0, durationMs: 300000 },
  { offsetMs: 292000, durationMs: 300000 },
  { offsetMs: 584000, durationMs: 26000 },
]);
```

Also test invalid overlap `-1`, `31`, and `>= chunkSeconds` fails.

- [ ] **Step 5: Implement minimal bounded windows**

Validate:

```js
if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 30 || overlapSeconds >= chunkSeconds) {
  throw new Error('overlapSeconds must be an integer from 0 through 30 and less than chunkSeconds.');
}
```

Use stride:

```js
const strideMs = (chunkSeconds - overlapSeconds) * 1000;
```

For each window, invoke FFmpeg against the downloaded local source using explicit start and duration so every output window remains <= 300 seconds. Return the real `offsetMs` and measured `durationMs`.

- [ ] **Step 6: Verify focused tests GREEN and commit**

Expected: media request + window tests pass without changing production deploy workflow.

---

### Task 3: Add pure conservative ASR stitching

**Files:**
- Create: `worker/src/services/asr/stitch.ts`
- Modify: `worker/src/services/asr/normalize.ts`
- Modify: `worker/test/asr.test.ts`

**Interfaces:**
- Consumes: `AsrChunkForNormalization[]`.
- Produces: `stitchAsrChunks(chunks): NormalizedAsrSegment[]`.
- Preserves: `normalizeAsrChunks(chunks)` as low-level deterministic chunk normalization for existing callers/tests.

- [ ] **Step 1: Write failing deduplication tests**

Add adjacent overlapping chunks where the same utterance appears at nearly identical global times:

```ts
const chunks = [
  { projectId: 'p1', chunkId: 'c1', offsetMs: 0, segments: [{ startMs: 294000, endMs: 296000, text: ' Hello   World ', speakerIndex: 0 }] },
  { projectId: 'p1', chunkId: 'c2', offsetMs: 292000, segments: [{ startMs: 2000, endMs: 4000, text: 'hello world', speakerIndex: 3 }] },
];
const stitched = stitchAsrChunks(chunks);
expect(stitched).toHaveLength(1);
```

- [ ] **Step 2: Write failing confident speaker-union test**

Assert the retained segment and a later `c2` segment from speaker `3` share the same deterministic `speakerId`.

- [ ] **Step 3: Write failing ambiguity test**

Construct overlap duplicates where one left local speaker has evidence pointing at two right local speakers. Assert no cross-chunk merge occurs and both right identities remain separate.

- [ ] **Step 4: Write failing non-diarized test**

Duplicate Whisper segments without `speakerIndex` must collapse to one segment and retain `speakerId === undefined`.

- [ ] **Step 5: Verify focused ASR tests RED**

```bash
npx vitest run worker/test/asr.test.ts
```

Expected: FAIL because `stitchAsrChunks` does not exist.

- [ ] **Step 6: Implement normalization + duplicate predicate**

In `stitch.ts`, normalize text with:

```ts
value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('und')
```

Duplicate predicate requires equal normalized non-empty text, start/end deltas <= 1500 ms, and intersection >= 50% of the shorter duration.

- [ ] **Step 7: Implement one-to-one evidence and union-find**

Represent each local speaker as `${chunkId}:${speakerIndex}`. Build left->right and right->left candidate sets only from duplicate pairs. Union only when both sets have size exactly one and point to each other.

Derive the stitched speaker ID from the lexicographically smallest member in the union set and the existing stable hash family:

```ts
`spk_${stableHash(`${projectId}:${canonicalLocalIdentity}`)}`
```

- [ ] **Step 8: Remove later duplicate utterances and return stable sorted output**

Keep the earlier chunk's copy of a duplicate. Preserve deterministic segment IDs from `normalizeAsrChunks`.

- [ ] **Step 9: Verify ASR tests GREEN and commit**

Run the focused test plus the full Vitest suite.

---

### Task 4: Integrate stitching into the durable dubbing pipeline

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`

**Interfaces:**
- Consumes: `stitchAsrChunks(normalizedInputs)`.
- Produces: the same persistence shape `{ id, speakerId, startMs, endMs, sourceText }[]` used by `SegmentStore.replaceFromAsr`.

- [ ] **Step 1: Write failing workflow test**

Use two overlapping fake ASR chunks containing one duplicate boundary utterance and one later utterance from the mapped speaker. Assert `replaceFromAsr` receives two persisted segments rather than three and both diarized segments share one speaker ID.

- [ ] **Step 2: Verify workflow test RED**

Expected: existing pipeline calls `normalizeAsrChunks`, so duplicate persists and speaker IDs differ.

- [ ] **Step 3: Replace the pipeline normalization call**

Change only the normalization boundary:

```ts
import { stitchAsrChunks } from '../services/asr/stitch';
...
const normalized = stitchAsrChunks(normalizedInputs).map(...);
```

Do not alter translation batching, cancellation, telemetry, or usage writes.

- [ ] **Step 4: Assert usage remains actual processed seconds**

Extend the workflow test so ASR usage units equal the sum of returned overlapping chunk durations. No deduplicated transcript duration is substituted into accounting.

- [ ] **Step 5: Verify workflow + full Vitest GREEN and commit**

---

### Task 5: Close acceptance, docs, and exact-head CI

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment-status.md`
- Modify if needed: `tests/phase4a-speaker-stitching-acceptance.test.mjs`

**Interfaces:**
- Produces: truthful source qualification language and final Phase 4A acceptance gate.

- [ ] **Step 1: Update docs truthfully**

Document that source now performs conservative overlap-evidence stitching, but explicitly retain:

- runtime `UNQUALIFIED`;
- production manual-only;
- real Deepgram/media fixture still required for production diarization PASS;
- ambiguous/no-evidence identities remain chunk-scoped;
- no acoustic speaker recognition or voice cloning is claimed.

- [ ] **Step 2: Run complete verification**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: all tests, typecheck/build, Phase 4A acceptance, and dry-run GREEN.

- [ ] **Step 3: Confirm exact feature-head GitHub Actions GREEN**

Record branch head SHA, workflow run ID, and verify job conclusion `success`. Do not use an older run after the branch head moves.

- [ ] **Step 4: Open PR with explicit non-deploy boundary**

PR body must summarize algorithm, ambiguity fail-safe, accounting behavior, tests, and say `Production deploy: NOT PERFORMED`.

- [ ] **Step 5: Review exact diff and CI, then merge using expected head SHA**

Merge only if the PR head still equals the reviewed/tested SHA and CI is fully GREEN.

- [ ] **Step 6: Verify post-merge main CI**

Confirm the push CI runs on the merge SHA and succeeds. Production runtime status stays UNQUALIFIED and no production deployment is triggered.
