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
- Modify: `tests/zero-container-export-workflow.test.mjs`
- Create: `tests/client-pcm-voice-cache.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: current zero-container export and project route layout.
- Produces: RED source gates for `targetVoiceObjectKey`, client PCM route mounting, version-safe persistence and cache-aware export admission.

- [ ] **Step 1: Add failing acceptance checks**

Require source to contain:

```js
assert.match(appSource, /createClientVoiceRoutes/);
assert.match(clientVoiceSource, /X-DubFlow-Translation-Version/i);
assert.match(clientVoiceSource, /8\s*\*\s*1024\s*\*\s*1024/);
assert.match(clientVoiceSource, /setVoiceResultForVersion/);
assert.match(exportSource, /clientVoiceArtifactsComplete/);
assert.match(exportSource, /targetVoiceObjectKey/);
assert.match(zeroSource, /targetVoiceObjectKey/);
```

Also assert the new route source contains no Stream/Container/Grok/ElevenLabs provider call.

- [ ] **Step 2: Wire the new Node test into `verify:deploy-config`**

Add `tests/client-pcm-voice-cache.test.mjs` to the existing Node test command.

- [ ] **Step 3: Run CI to verify RED**

Expected: source/deploy verification fails only on the newly added client PCM acceptance contract; pre-existing tests remain green.

- [ ] **Step 4: Commit RED evidence**

Commit message: `test(voice): require zero-cost client PCM cache lane`

---

### Task 2: Share canonical target voice object keys

**Files:**
- Create: `worker/src/services/voice/object-key.ts`
- Modify: `worker/src/workflows/zeroContainerExportPipeline.ts`
- Test: `worker/test/zero-container-export-pipeline.test.ts` or nearest existing zero-container test file

**Interfaces:**
- Produces:

```ts
export function targetVoiceObjectKey(
  projectId: string,
  targetLanguage: TargetLanguage,
  segmentId: string,
  version: number,
): string;
```

- [ ] **Step 1: Add unit test for canonical key**

Expected result for `p1`, `vi`, `s1`, version `3`:

```text
projects/p1/voices/vi/s1/3.pcm
```

- [ ] **Step 2: Verify the test fails because the shared helper does not exist**

- [ ] **Step 3: Add the helper and replace the local workflow function**

Reject no inputs here; callers already validate identifiers/version. Keep the helper pure.

- [ ] **Step 4: Run targeted worker tests**

Expected: key test and existing zero-container reuse tests pass.

- [ ] **Step 5: Commit**

Commit message: `refactor(voice): share target PCM object key`

---

### Task 3: Add version-safe voice persistence

**Files:**
- Modify: `worker/src/db/segment-translations.ts`
- Test: nearest existing translation-variant persistence test in `worker/test`

**Interfaces:**
- Produces:

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

- [ ] **Step 1: Write tests for matching and stale versions**

Matching version must set `voice_status='completed'` and canonical object key without changing translation version. Stale version must throw `SegmentTranslationPersistenceError('TRANSLATION_VARIANT_CONFLICT', ...)` with canonical state.

- [ ] **Step 2: Run targeted test and verify RED**

- [ ] **Step 3: Implement the optimistic update**

Use:

```sql
UPDATE segment_translations
SET voice_status = 'completed', dubbed_object_key = ?, updated_at = datetime('now')
WHERE segment_id = ? AND project_id = ? AND target_language = ?
  AND EXISTS (SELECT 1 FROM projects WHERE id = project_id AND user_id = ?)
  AND version = ?
```

If affected rows are zero, reload canonical state and distinguish not-found vs conflict.

- [ ] **Step 4: Run persistence tests**

- [ ] **Step 5: Commit**

Commit message: `feat(voice): persist client PCM by translation version`

---

### Task 4: Add bounded client PCM upload route

**Files:**
- Create: `worker/src/routes/client-voice.ts`
- Modify: `worker/src/app.ts`
- Create: `worker/test/client-voice-route.test.ts`

**Interfaces:**
- Endpoint: `PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm`
- Consumes: `ProjectRepository`, `SegmentRepository`, `SegmentTranslationRepository`, `targetVoiceObjectKey`, `env.MEDIA.put`.
- Produces JSON `{ targetLanguage, segmentId, version, voiceStatus: 'completed', objectKey }`.

- [ ] **Step 1: Write route tests**

Cover:
- authorized valid Vietnamese upload stores exact bytes under canonical key and persists completed state;
- non-`vi` target returns 400 `CLIENT_VOICE_LANGUAGE_UNSUPPORTED`;
- invalid/missing PCM metadata returns 400;
- missing/zero/odd byte body returns 400;
- body > 8 MiB returns 413;
- stale `X-DubFlow-Translation-Version` returns 409;
- missing project/segment/translation returns 404;
- incomplete/blank translation returns 409;
- no provider is called.

- [ ] **Step 2: Run targeted route tests and verify RED**

- [ ] **Step 3: Implement route validation**

Constants:

```ts
const CLIENT_PCM_SAMPLE_RATE = 24_000;
const CLIENT_PCM_CHANNELS = 1;
const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;
```

Read `Content-Length` when present for an early oversize rejection, then `arrayBuffer()` and enforce exact post-read bound. Require even byte length for s16le.

- [ ] **Step 4: Store and persist in safe order**

Store to the versioned key, then call `setVoiceResultForVersion`. A race after storage cannot make stale audio current because version is part of the key.

- [ ] **Step 5: Mount route under `/api/projects`**

- [ ] **Step 6: Run route + persistence + zero-container tests**

- [ ] **Step 7: Commit**

Commit message: `feat(voice): accept bounded client PCM uploads`

---

### Task 5: Make dubbed export cache-aware

**Files:**
- Modify: `worker/src/routes/export.ts`
- Modify/Create: appropriate `worker/test/export*.test.ts`

**Interfaces:**
- Produces pure helper:

```ts
clientVoiceArtifactsComplete(
  projectId: string,
  targetLanguage: TargetLanguage,
  sourceSegments: Array<{ id: string }>,
  variants: SegmentTranslation[],
): boolean
```

- [ ] **Step 1: Write RED behavior test**

When provider capabilities are `{ configured: false, languages: 'unknown', ... }`, a dubbed `vi` export with every current variant pointing to its exact canonical PCM key must pass voice admission and launch. The same request with one missing/stale PCM artifact must preserve `VOICE_PROVIDER_UNCONFIGURED`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement exact-cache helper**

Require variant count to equal source segment count, one variant per source id, completed/non-empty translation, positive integer version, `voiceStatus === 'completed'`, and exact canonical key.

- [ ] **Step 4: Apply provider check conditionally**

For dubbed output:

```ts
if (!clientVoiceArtifactsComplete(...)) {
  const voiceError = voiceTargetError(getVoiceCapabilities(env), targetLanguage);
  if (voiceError) return voiceError;
}
```

Do not weaken any other export admission.

- [ ] **Step 5: Run targeted export tests**

- [ ] **Step 6: Commit**

Commit message: `feat(export): reuse complete client PCM voice cache`

---

### Task 6: Full verification and integration gate

**Files:**
- Update docs only if tests reveal contract details that need correction.

- [ ] **Step 1: Run full repository verification**

Run: `npm run verify`
Expected: all tests and build pass.

- [ ] **Step 2: Run checked-in Wrangler dry-run**

Use the same command as CI. Expected: pass without Stream/Container bindings.

- [ ] **Step 3: Run generated-production Wrangler dry-run**

Use the same command as CI. Expected: pass.

- [ ] **Step 4: Review exact PR diff**

Confirm no provider secret, paid service, Stream, Container or production-deploy action was added.

- [ ] **Step 5: Revalidate latest `main`**

If `main` moved, compare file overlap. Refresh non-force only if needed, then require fresh exact-head CI.

- [ ] **Step 6: Merge only on full GREEN**

Keep #91 open; this carrier only provides the server half of zero-cost client TTS.

- [ ] **Step 7: Start follow-up browser Piper carrier**

Base it on the merged backend SHA and implement `@mintplex-labs/piper-tts-web` with `vi_VN-vais1000-medium`, WAV decode/resample to 24 kHz mono, s16le encoding and API upload before dubbed export.
