# Zero-cost Client PCM Voice Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a version-safe project API for client-generated Vietnamese PCM and let the existing R2-only export pipeline reuse complete client voice caches without requiring a paid server TTS provider.

**Architecture:** Browser synthesis is outside this carrier. This carrier adds one deterministic PCM artifact key shared by upload/export, a version-safe persistence operation, a bounded binary upload route, and cache-aware export admission. The current provider selector and zero-container rendering path remain intact as fallback.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/D1/R2, Vitest, Node acceptance tests.

**Spec:** `docs/superpowers/specs/2026-09-07-zero-cost-client-pcm-voice-cache.md`

## Global Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit/top-up requirement.
- No new paid provider or provider secret.
- Zero-cost client PCM qualification is `vi` only in this carrier.
- Stored audio is raw signed 16-bit little-endian, mono, exactly 24,000 Hz.
- Maximum client PCM upload is 8 MiB.
- Translation-version mismatch is fail-closed.
- Existing provider-backed export remains available when client cache is incomplete.

---

### Task 1: Lock the regression contract

**Files:**
- Create: `tests/client-pcm-voice-cache.test.mjs`
- Modify: `package.json`

- [ ] Add RED source gates for route mounting, bounded PCM validation, shared object keys, version-safe persistence, and cache-aware export admission.
- [ ] Wire the test into `verify:deploy-config`.
- [ ] Run fresh PR CI and record the intended RED before touching runtime.

### Task 2: Share canonical target voice object keys

**Files:**
- Create: `worker/src/services/voice/object-key.ts`
- Modify: `worker/src/workflows/zeroContainerExportPipeline.ts`

**Interface:**

```ts
export function targetVoiceObjectKey(
  projectId: string,
  targetLanguage: TargetLanguage,
  segmentId: string,
  version: number,
): string;
```

- [ ] Add unit coverage for `projects/p1/voices/vi/s1/3.pcm`.
- [ ] Replace the local zero-container helper with the shared helper.
- [ ] Verify existing cache reuse behavior remains green.

### Task 3: Add version-safe voice persistence

**Files:**
- Modify: `worker/src/db/segment-translations.ts`
- Test: translation persistence tests under `worker/test`

**Interface:**

```ts
setVoiceResultForVersion(
  projectId: string,
  segmentId: string,
  userId: string,
  target: TargetLanguage,
  expectedVersion: number,
  objectKey: string,
): Promise<SegmentTranslation>
```

- [ ] Write matching-version and stale-version tests.
- [ ] Implement `UPDATE ... AND version = ?`.
- [ ] On zero changed rows reload canonical state and distinguish not-found from `TRANSLATION_VARIANT_CONFLICT`.

### Task 4: Add bounded client PCM upload route

**Files:**
- Create: `worker/src/routes/client-voice.ts`
- Modify: `worker/src/app.ts`
- Create: `worker/test/client-voice-route.test.ts`

**Endpoint:** `PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm`

Required headers:

```text
Content-Type: application/octet-stream
X-DubFlow-PCM-Format: s16le
X-DubFlow-PCM-Sample-Rate: 24000
X-DubFlow-PCM-Channels: 1
X-DubFlow-Translation-Version: <positive integer>
```

Constants:

```ts
const CLIENT_PCM_SAMPLE_RATE = 24_000;
const CLIENT_PCM_CHANNELS = 1;
const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;
```

- [ ] Test valid `vi` upload stores exact bytes at the canonical versioned key and marks voice completed.
- [ ] Test non-`vi`, malformed headers, empty/odd PCM, >8 MiB, stale version, missing project/segment/variant, and incomplete translation.
- [ ] Implement fail-closed validation and store-before-version-safe-persist semantics.
- [ ] Mount under `/api/projects`.

### Task 5: Make dubbed export cache-aware

**Files:**
- Modify: `worker/src/routes/export.ts`
- Test: existing/new export route tests under `worker/test`

**Interface:**

```ts
clientVoiceArtifactsComplete(
  projectId: string,
  targetLanguage: TargetLanguage,
  sourceSegments: Array<{ id: string }>,
  variants: SegmentTranslation[],
): boolean
```

- [ ] RED test: provider unconfigured + complete exact-version client cache launches dubbed export.
- [ ] RED control: one missing/stale cached voice still returns existing provider admission error.
- [ ] Implement strict cardinality/id/version/status/key checks.
- [ ] Skip `voiceTargetError` only when the entire exact cache is complete.

### Task 6: Full integration gate

- [ ] Run full `npm run verify` through fresh exact-head CI.
- [ ] Require checked-in Wrangler dry-run PASS.
- [ ] Require generated-production Wrangler dry-run PASS.
- [ ] Require screenshots/artifact PASS.
- [ ] Review exact diff for zero paid-service/Stream/Container/provider-secret additions.
- [ ] Revalidate latest `main`; if drift exists, reconcile non-force and require fresh CI.
- [ ] Merge only on FULL GREEN.
- [ ] Keep #91 open and start the follow-up browser Piper carrier from the merged backend SHA.
