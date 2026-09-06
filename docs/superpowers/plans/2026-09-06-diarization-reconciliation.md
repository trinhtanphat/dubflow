# Project-Stable Diarization Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile live main's existing cross-chunk stitching with the approved 15-second overlap, stronger deterministic speaker evidence, and safe historical speaker-ID reuse while preserving the merged translation-context subsystem.

**Architecture:** Keep the current `audio-windows.mjs` media abstraction and contextual-translation pipeline. Strengthen the pure ASR stitcher, add a pure historical reconciliation module, then insert history loading/reconciliation after all ASR calls and before destructive replacement. No new D1 migration or biometric identity state.

**Tech Stack:** TypeScript, Vitest, Node.js FFmpeg container, Cloudflare Workers/Workflows/R2/D1, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-06-diarization-reconciliation-design.md`

## Global Constraints

- Production ASR windows: exactly 300 seconds with 15-second overlap (285-second stride).
- Duplicate timing delta: <= 1,500 ms.
- Speaker edge: >= 1 duplicate and >= 750 ms total matched temporal intersection.
- Numeric ties remain unmerged.
- Historical reuse: >= 2,000 ms, unique best, one old ID cannot be ambiguously claimed twice.
- Existing `0007_translation_context.sql` is preserved and no new diarization migration is added.
- Phase 3B ASR units remain `chunk.durationMs / 1000`.
- Existing translation-context behavior, Phase 3C telemetry/rate limits/sharing, cancellation and failure semantics remain unchanged.
- No embeddings, voiceprints, biometric templates, voice cloning, or production-runtime qualification.

---

### Task 1: Strengthen the existing overlap/stitch contract

**Files:**
- Modify: `worker/src/services/media/container.ts`
- Modify: `worker/src/services/asr/stitch.ts`
- Modify: `worker/test/asr.test.ts`
- Modify: `worker/test/media-processor.test.ts`
- Modify: `tests/phase4a-speaker-stitching-acceptance.test.mjs`

**Interfaces:**
- Preserve `stitchAsrChunks(chunks: AsrChunkForNormalization[]): NormalizedAsrSegment[]`.
- Production media request changes only from overlap 8 to 15 seconds.
- No provider adapter changes.

- [ ] **Step 1: Write RED tests** for production overlap 15, punctuation-normalized overlap dedupe/stitch, and a <750ms duplicate that dedupes but does not merge speaker identity.
- [ ] **Step 2: Run focused tests** and verify the new assertions fail for the intended current-main behavior.
- [ ] **Step 3: Change production overlap** to `overlapSeconds: 15`; keep `audio-windows.mjs` generic and validation unchanged.
- [ ] **Step 4: Strengthen `stitch.ts`** with NFKC + en-US lowercase + whitespace collapse + Unicode punctuation/symbol removal, per-boundary `{matchCount, matchedDurationMs}` speaker scores, >=750ms threshold, and mutual unique numeric-best pairing.
- [ ] **Step 5: Run focused + adjacent tests** and verify all pass.
- [ ] **Step 6: Commit** `feat: strengthen cross-chunk speaker evidence`.

---

### Task 2: Add pure historical speaker reconciliation

**Files:**
- Create: `worker/src/services/asr/reconcile.ts`
- Create: `worker/test/asr-reconcile.test.ts`

**Interfaces:**

```ts
export type ExistingSpeakerCoverage = {
  speakerId: string;
  ranges: Array<{ startMs: number; endMs: number }>;
};

export function reconcileSpeakerIds(
  stitched: NormalizedAsrSegment[],
  existing: ExistingSpeakerCoverage[],
): NormalizedAsrSegment[];
```

- [ ] **Step 1: Write RED tests** for unique >=2s reuse, below-threshold non-reuse, tied historical coverage, deterministic input-order independence, and two new clusters competing for one old ID.
- [ ] **Step 2: Verify RED** because `reconcile.ts` does not exist.
- [ ] **Step 3: Implement summed temporal intersection**, unique-best selection and deterministic global competition resolution.
- [ ] **Step 4: Verify focused tests GREEN**.
- [ ] **Step 5: Commit** `feat: reconcile stitched speakers with project history`.

---

### Task 3: Integrate rerun reconciliation without regressing contextual translation

**Files:**
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/test/speaker-stitch-workflow.test.ts`
- Modify: `worker/test/dubbing-workflow.test.ts`
- Modify: `worker/test/dubbing-workflow-context.test.ts`
- Modify: `worker/test/provider-telemetry-workflows.test.ts`
- Modify: `worker/test/asr-persistence.test.ts`

**Interfaces:**
- `PipelineSegments` adds `list` while preserving `replaceFromAsr` and `setTranslationResult` including translation-context revision behavior.
- History is loaded only after all ASR calls complete and before `replaceFromAsr`.

- [ ] **Step 1: Write RED workflow test** where old `spk_existing` overlaps a newly stitched cluster >=2s and assert replacement receives `spk_existing`; record call order proving ASR completes before history load and history load precedes replacement.
- [ ] **Step 2: Verify RED** on current pipeline.
- [ ] **Step 3: Add pure coverage grouping helper** in pipeline and call `segments.list`, `stitchAsrChunks`, `reconcileSpeakerIds`, then `replaceFromAsr`.
- [ ] **Step 4: Align legacy fixtures** with `segments.list()`, normally returning `[]`, without weakening the production type.
- [ ] **Step 5: Add/retain persistence qualification** proving reused speaker IDs use `ON CONFLICT(id) DO NOTHING` and do not overwrite custom display name / ElevenLabs voice metadata.
- [ ] **Step 6: Run workflow, translation-context, telemetry, persistence and full Vitest tests**.
- [ ] **Step 7: Commit** `feat: preserve speaker identity across ASR reruns`.

---

### Task 4: Acceptance, docs, and integration

**Files:**
- Create: `tests/project-stable-diarization-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- Acceptance must distinguish “no diarization migration” from the legitimate existing `0007_translation_context.sql` migration.

- [ ] **Step 1: Write acceptance gate** covering 300/15 overlap, 750ms speaker edge, 2s historical reuse, ASR-before-history-before-replacement ordering, actual overlap usage units, conflict-ignore speaker metadata preservation, no biometric state, and preserved translation-context migration.
- [ ] **Step 2: Wire it into `verify:deploy-config`** and verify RED only for missing final docs if source already satisfies the gate.
- [ ] **Step 3: Update deployment status** to describe project-stable rerun reuse while keeping production runtime **UNQUALIFIED**.
- [ ] **Step 4: Run fresh full `npm run verify`, `npx wrangler deploy --dry-run`, and existing screenshot/artifact CI on exact head.**
- [ ] **Step 5: Re-read live `main`; non-force reconcile only if it advanced.**
- [ ] **Step 6: Open PR, require PR exact-head FULL GREEN, check reviews/threads/mergeability, merge with `expected_head_sha`, and require post-merge `main` FULL GREEN.**
