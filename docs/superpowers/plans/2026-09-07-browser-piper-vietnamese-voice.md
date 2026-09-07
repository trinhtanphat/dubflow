# Browser Piper Vietnamese Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vietnamese `dubbed_only` export work without a paid server TTS call by generating Piper speech locally in the browser, converting it to the backend's canonical 24 kHz mono s16le PCM contract, uploading only missing/stale exact-version voices, then launching the existing export flow.

**Architecture:** Add a browser-only Piper adapter, a deterministic WAV-to-PCM converter, and a cache-preload orchestrator that fetches fresh Vietnamese translation variants before synthesis. Studio export calls the orchestrator only for Vietnamese `dubbed_only` work; the existing server voice provider remains a fallback for other languages/deployments, while the UI admits Vietnamese dubbed export when the local Piper runtime is supported even if server TTS is unconfigured.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, `@mintplex-labs/piper-tts-web@1.0.5`, existing Hono client API.

**Spec:** `docs/superpowers/specs/2026-09-07-zero-cost-client-pcm-voice-cache.md`

## Global Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit/top-up requirement.
- No new paid provider or provider secret.
- Zero-cost client synthesis is initially qualified only for target language `vi`.
- Piper voice is pinned to `vi_VN-vais1000-medium`.
- Piper inference happens only in the browser; do not import/execute Piper on the Worker or Node server path.
- Backend upload remains raw signed 16-bit little-endian, mono, exactly 24,000 Hz.
- Translation version is authoritative; stale client audio must never satisfy a newer translation.
- Only synthesize missing/stale Vietnamese voice artifacts; exact current cache entries are reused.
- Preload runs before `dubbed_only` export only. Subtitle-only export must never load Piper.
- No silent fallback from the zero-cost preload to `/api/voice/preview` or any paid server TTS request.
- Existing provider-backed behavior remains intact for non-Vietnamese targets/deployments that intentionally configure it.

---

### Task 1: Lock frontend zero-cost RED contract

**Files:**
- Create: `tests/browser-piper-voice.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: merged backend route `/api/projects/:id/translations/vi/:segmentId/voice-pcm`.
- Produces: source-level acceptance gates for dependency pinning, browser-only Piper adapter, 24 kHz conversion, upload API, cache preload, and Studio export integration.

- [ ] **Step 1: Add source acceptance assertions** requiring all of:
  - dependency `@mintplex-labs/piper-tts-web` is exactly `1.0.5`;
  - `PIPER_VI_VOICE_ID = 'vi_VN-vais1000-medium'` exists in a browser-only adapter;
  - a WAV conversion helper outputs 24,000 Hz mono s16le bytes;
  - `uploadClientVoicePcm(...)` uses the five backend PCM headers;
  - a preload orchestrator fetches fresh `vi` variants and skips exact current cache entries;
  - `StudioShell` invokes preload before current/batch Vietnamese `dubbed_only` export;
  - subtitle-only export does not invoke preload;
  - `BatchExportPanel` can admit `vi` through a local-client capability without weakening non-`vi` provider guards.
- [ ] **Step 2: Wire `tests/browser-piper-voice.test.mjs` into `verify:deploy-config`.**
- [ ] **Step 3: Push the test-only commit and open a draft PR.**
- [ ] **Step 4: Require fresh exact-head CI RED only because the new frontend lane is absent.** Baseline tests/build must not be the root cause.

### Task 2: Add deterministic WAV → 24 kHz mono s16le conversion

**Files:**
- Create: `src/features/voice/clientPcm.ts`
- Create: `src/features/voice/clientPcm.test.ts`

**Interfaces:**
- Produces:
```ts
export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export function wavToClientPcm(wav: ArrayBuffer): Uint8Array;
```

- [ ] **Step 1: Write RED tests** with synthetic RIFF/WAVE fixtures covering 22,050 Hz mono PCM16, stereo downmix, malformed RIFF/fmt/data chunks, unsupported non-PCM/bit depth, and deterministic output length `round(frames * 24000 / sourceRate) * 2`.
- [ ] **Step 2: Run targeted Vitest and confirm RED.**
- [ ] **Step 3: Implement a bounded RIFF parser.** Require `RIFF`/`WAVE`, locate `fmt ` and `data`, require PCM format 1, 16-bit samples, positive sample rate and channel count.
- [ ] **Step 4: Decode source frames to mono, linearly resample to 24 kHz, clamp to signed 16-bit, and emit little-endian bytes.** Do not use Node-only APIs.
- [ ] **Step 5: Run targeted tests GREEN and commit.**

### Task 3: Add exact client PCM upload API

**Files:**
- Modify: `src/features/voice/voiceApi.ts`
- Modify: `src/features/voice/voiceApi.test.ts`

**Interfaces:**
- Produces:
```ts
export type ClientVoiceUploadResult = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: string;
  objectKey: string | null;
};

export function uploadClientVoicePcm(
  projectId: string,
  segmentId: string,
  translationVersion: number,
  pcm: Uint8Array,
  fetchImpl?: typeof fetch,
): Promise<ClientVoiceUploadResult>;
```

- [ ] **Step 1: Write RED request-contract tests.** Require encoded project/segment IDs, `PUT`, `application/octet-stream`, `X-DubFlow-PCM-Format: s16le`, sample rate `24000`, channels `1`, exact translation version, and byte-identical body.
- [ ] **Step 2: Write RED error test** proving a backend 409 `TRANSLATION_VARIANT_CONFLICT` surfaces as `ApiError` and is not converted into a provider fallback.
- [ ] **Step 3: Implement the API call and JSON error parsing using the existing `ApiError` convention.**
- [ ] **Step 4: Run `voiceApi.test.ts` GREEN and commit.**

### Task 4: Add browser-only Piper adapter and cache preload orchestrator

**Files:**
- Modify: `package.json`
- Create: `src/features/voice/clientPiperVoice.ts`
- Create: `src/features/voice/clientPiperVoice.test.ts`

**Interfaces:**
- Consumes: `getTranslationVariants(projectId, 'vi')`, `wavToClientPcm`, `uploadClientVoicePcm`.
- Produces:
```ts
export const PIPER_VI_VOICE_ID = 'vi_VN-vais1000-medium';
export function isLocalPiperSupported(): boolean;
export async function prepareVietnameseClientVoiceCache(
  projectId: string,
  services?: ClientPiperVoiceServices,
): Promise<{ synthesized: number; reused: number }>;
```

- [ ] **Step 1: Pin `@mintplex-labs/piper-tts-web` to exact version `1.0.5`.**
- [ ] **Step 2: Write RED tests** proving:
  - current canonical cache `projects/{projectId}/voices/vi/{segmentId}/{version}.pcm` is reused;
  - missing/stale cache synthesizes sequentially from fresh completed/non-empty translations;
  - Piper receives `voiceId: 'vi_VN-vais1000-medium'`;
  - WAV bytes are converted before upload;
  - upload receives the exact translation version;
  - incomplete/missing translation fails closed before synthesis;
  - a 409 upload conflict propagates and export must not start;
  - no `fetchVoicePreview`/server TTS fallback exists in this orchestrator.
- [ ] **Step 3: Implement `isLocalPiperSupported()`** as a browser capability check requiring `window`, `WebAssembly`, `navigator.storage`, and `navigator.storage.getDirectory`.
- [ ] **Step 4: Implement default Piper service with a lazy dynamic import:**
```ts
const tts = await import('@mintplex-labs/piper-tts-web');
return tts.predict({ text, voiceId: PIPER_VI_VOICE_ID });
```
  The module must not be imported at top level.
- [ ] **Step 5: Implement fresh-variant cache admission and sequential preload.** Never trust stale React state for translation versions.
- [ ] **Step 6: Run targeted tests GREEN and commit.**

### Task 5: Admit local Vietnamese voice and preload before Studio export

**Files:**
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/app/StudioShell.tsx`
- Modify/Create: focused Studio export tests under `src/app/`

**Interfaces:**
- Consumes: `isLocalPiperSupported`, `prepareVietnameseClientVoiceCache`.
- Produces: UI/export behavior that treats local Piper as a valid `vi` dubbed source while retaining provider gates elsewhere.

- [ ] **Step 1: Write RED `dubbedAvailability` tests.** Provider unconfigured + local client available + `vi` => allowed; same state + `ja` => blocked; local unavailable preserves current behavior.
- [ ] **Step 2: Extend `BatchExportPanelView` with `localVietnameseVoiceAvailable: boolean` (default `false`) and pass it only into Vietnamese dubbed admission.** Do not change separation or lip-sync gates.
- [ ] **Step 3: Write RED Studio action tests** proving current `vi` + `dubbed_only` calls preload before `startLanguageExport`, selected batch containing `vi` calls preload before `startBatchExport`, subtitle export never preloads, and preload rejection prevents export launch.
- [ ] **Step 4: In `StudioShell`, compute local support once per render/runtime and call preload only when `output === 'dubbed'`, `audioMode === 'dubbed_only'`, and the requested target set includes `vi`.**
- [ ] **Step 5: Keep existing busy/error handling.** Piper/model download uses the current export busy state; a preload failure surfaces through `exportError` and does not launch export.
- [ ] **Step 6: Run focused UI/Studio tests GREEN and commit.**

### Task 6: Full source and production-config qualification

**Files:**
- Review only unless a proven regression requires a minimal fix.

- [ ] **Step 1: Run/fresh-trigger exact-head CI and require `verify:deploy-config` GREEN, all Vitest GREEN, production build GREEN.**
- [ ] **Step 2: Require Wrangler checked-in config dry-run PASS.**
- [ ] **Step 3: Require generated-production Wrangler dry-run PASS.**
- [ ] **Step 4: Require reference screenshots and artifact upload PASS.**
- [ ] **Step 5: Review exact PR diff.** Reject any AI Gateway top-up, provider secret, Stream, Container, server-side Piper import, or unrelated production-config change.
- [ ] **Step 6: Revalidate latest `main`; if drift exists, compare paths first and reconcile non-force only when safe, then require fresh exact-head CI.**
- [ ] **Step 7: Run code-review and verification-before-completion gates.**
- [ ] **Step 8: Merge only when exact head is FULL GREEN.**
- [ ] **Step 9: Keep #91 OPEN/UNQUALIFIED.** The next carrier must update the real production fixture to exercise this browser-local/client-PCM path; only final H.264/AAC/R2/packet-preservation success may close #91.
