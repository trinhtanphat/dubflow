# Browser Piper Voice Preload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-cost Vietnamese browser Piper preload lane that produces exact-version 24 kHz mono s16le PCM, uploads it through the backend #113 API, and starts the existing R2-only export only after the Vietnamese voice cache is complete.

**Architecture:** Keep Piper behind a browser-only adapter and keep PCM conversion as a pure deterministic unit. A preload coordinator reads canonical Vietnamese translation variants, skips exact-version cache hits, synthesizes and uploads misses sequentially, re-verifies the cache, then allows the existing export APIs to run unchanged. `StudioShell` owns orchestration/UI state; non-`vi` languages retain current server-provider admission.

**Tech Stack:** Vite 7, React 19, TypeScript 5.8, Vitest 3, `@mintplex-labs/piper-tts-web@1.0.5`, browser Web Audio decoding, Cloudflare Worker API already merged in PR #113.

**Spec:** `docs/superpowers/specs/2026-09-07-browser-piper-voice-preload-design.md`

## Global Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit/top-up.
- No implicit Grok, ElevenLabs, or other paid TTS fallback.
- Browser Piper is qualified only for target language `vi` in this carrier.
- Existing server-provider behavior remains unchanged for non-`vi` languages.
- Existing separated-background and visual lip-sync capability gates remain unchanged.
- Client PCM upload contract is signed 16-bit little-endian, mono, exactly 24,000 Hz, maximum 8 MiB per segment.
- Translation version is authoritative; version N audio must never attach to version N+1.
- Export must not start for `vi` until every current translated segment has a complete exact-version client PCM artifact.
- Piper dependency is pinned exactly to `1.0.5`.
- Piper voice id is exactly `vi_VN-vais1000-medium`.
- Model loading must be lazy; no eager Piper import from application entrypoints.

---

### Task 1: Lock the browser Piper source contract RED

**Files:**
- Create: `tests/browser-piper-voice-preload.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: backend #113 route and current `StudioShell` export flow.
- Produces: a RED acceptance gate that later tasks must satisfy.

- [ ] **Step 1: Add the failing source-contract test**

Create `tests/browser-piper-voice-preload.test.mjs` that reads `package.json`, `src/features/voice/browserPiper.ts`, `src/features/voice/pcm.ts`, `src/features/voice/clientVoiceApi.ts`, `src/features/voice/clientVoicePreload.ts`, and `src/app/StudioShell.tsx`. Assert all of the following:

```js
assert.equal(pkg.dependencies['@mintplex-labs/piper-tts-web'], '1.0.5');
assert.match(browserPiperSource, /import\(['"]@mintplex-labs\/piper-tts-web['"]\)/);
assert.match(browserPiperSource, /vi_VN-vais1000-medium/);
assert.match(pcmSource, /24_000|24000/);
assert.match(clientVoiceApiSource, /X-DubFlow-PCM-Format/i);
assert.match(clientVoiceApiSource, /X-DubFlow-PCM-Sample-Rate/i);
assert.match(clientVoiceApiSource, /X-DubFlow-Translation-Version/i);
assert.match(preloadSource, /getTranslationVariants/);
assert.match(preloadSource, /uploadClientVoicePcm/);
assert.match(studioSource, /ensureVietnameseClientVoiceCache/);
assert.doesNotMatch(`${browserPiperSource}\n${preloadSource}`, /ElevenLabs|grok-tts|PAID_GROK_TTS_ENABLED/);
```

Also assert `src/main.tsx` does not contain `@mintplex-labs/piper-tts-web`.

- [ ] **Step 2: Wire the new test into `verify:deploy-config`**

Append `tests/browser-piper-voice-preload.test.mjs` next to `tests/client-pcm-voice-cache.test.mjs` in `package.json`.

- [ ] **Step 3: Commit RED only**

Commit message:

```text
test(voice): lock browser Piper preload contract
```

- [ ] **Step 4: Run fresh PR CI and require intended RED**

Expected RED: missing Piper dependency/files/orchestration only. Existing deploy/source gates must remain green.

---

### Task 2: Add exact Piper dependency and browser-only adapter

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/features/voice/browserPiper.ts`
- Create: `src/features/voice/browserPiper.test.ts`

**Interfaces:**
- Produces:

```ts
export const VIETNAMESE_PIPER_VOICE_ID = 'vi_VN-vais1000-medium';

export type PiperDownloadProgress = {
  percent: number | null;
  url?: string;
};

export type BrowserPiperRuntime = {
  isSupported(): boolean;
  ensureModel(onProgress?: (progress: PiperDownloadProgress) => void): Promise<void>;
  synthesize(text: string, onProgress?: (progress: PiperDownloadProgress) => void): Promise<Blob>;
};

export function createBrowserPiperRuntime(): BrowserPiperRuntime;
```

- [ ] **Step 1: Write failing adapter tests**

Test that `isSupported()` requires browser globals used by Piper/OPFS, `ensureModel()` maps `download()` progress to percent, and `synthesize()` passes exact text/voice id to `predict()`.

Use an injected loader internally so tests do not import the real browser-only package in Node:

```ts
type PiperModule = {
  download(voiceId: string, cb?: (p: { loaded: number; total: number; url?: string }) => void): Promise<unknown>;
  predict(input: { text: string; voiceId: string }, cb?: (p: { loaded: number; total: number; url?: string }) => void): Promise<Blob>;
};
```

- [ ] **Step 2: Implement lazy loader**

Implementation must contain only a dynamic import:

```ts
const loadPiper = () => import('@mintplex-labs/piper-tts-web');
```

No top-level static Piper import.

- [ ] **Step 3: Pin dependency exactly**

Add:

```json
"@mintplex-labs/piper-tts-web": "1.0.5"
```

Regenerate lockfile through the normal package-manager update mechanism; do not hand-edit integrity hashes.

- [ ] **Step 4: Run adapter tests and source contract**

Expected: adapter tests PASS; Task 1 contract still RED only for later missing files/orchestration.

- [ ] **Step 5: Commit**

```text
feat(voice): add lazy browser Piper runtime
```

---

### Task 3: Add deterministic WAV-to-24k s16le PCM conversion

**Files:**
- Create: `src/features/voice/pcm.ts`
- Create: `src/features/voice/pcm.test.ts`

**Interfaces:**
- Produces:

```ts
export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;

export function mixToMono(channels: Float32Array[]): Float32Array;
export function resampleLinear(input: Float32Array, sourceRate: number, targetRate?: number): Float32Array;
export function encodeS16Le(samples: Float32Array): Uint8Array;
export function canonicalPcmFromDecodedAudio(input: {
  sampleRate: number;
  channels: Float32Array[];
}): Uint8Array;

export async function decodeWavBlob(
  wav: Blob,
  decode: (data: ArrayBuffer) => Promise<{ sampleRate: number; numberOfChannels: number; getChannelData(index: number): Float32Array }>,
): Promise<Uint8Array>;
```

- [ ] **Step 1: Write failing pure unit tests**

Cover mono averaging, clipping (`-1 -> -32768`, `1 -> 32767`), little-endian bytes, deterministic `22_050 -> 24_000` output length using `Math.round(input.length * 24000 / 22050)`, empty/non-finite input rejection, and >8 MiB rejection.

- [ ] **Step 2: Implement pure converter**

Use linear interpolation:

```ts
const position = i * (sourceRate / targetRate);
const left = Math.floor(position);
const right = Math.min(left + 1, input.length - 1);
const fraction = position - left;
out[i] = input[left] + (input[right] - input[left]) * fraction;
```

Encoding uses `DataView.setInt16(offset, value, true)`.

- [ ] **Step 3: Add WAV decode boundary**

`decodeWavBlob()` calls the injected decoder, copies channel data into owned `Float32Array`s, then runs the pure converter. `StudioShell`/preload code will supply a short-lived browser `AudioContext.decodeAudioData` adapter.

- [ ] **Step 4: Run PCM tests**

Expected: all PASS, no browser DOM dependency in pure converter tests.

- [ ] **Step 5: Commit**

```text
feat(voice): convert Piper WAV to canonical PCM
```

---

### Task 4: Add authenticated binary client voice upload API

**Files:**
- Create: `src/features/voice/clientVoiceApi.ts`
- Create: `src/features/voice/clientVoiceApi.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, backend #113 `voice-pcm` endpoint.
- Produces:

```ts
export type ClientVoiceUploadResult = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: 'completed';
  objectKey: string;
};

export function canonicalClientVoiceObjectKey(
  projectId: string,
  segmentId: string,
  version: number,
): string;

export async function uploadClientVoicePcm(input: {
  projectId: string;
  segmentId: string;
  version: number;
  pcm: Uint8Array;
}): Promise<ClientVoiceUploadResult>;
```

- [ ] **Step 1: Write failing request tests**

Assert exact method/path/body and headers:

```text
Content-Type: application/octet-stream
X-DubFlow-PCM-Format: s16le
X-DubFlow-PCM-Sample-Rate: 24000
X-DubFlow-PCM-Channels: 1
X-DubFlow-Translation-Version: <version>
```

- [ ] **Step 2: Implement through `apiFetch`**

Pass the standalone `ArrayBuffer` for the exact `Uint8Array` slice so the request body cannot include unrelated backing-buffer bytes:

```ts
const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
```

Explicit `content-type` must override `apiFetch`'s default JSON header.

- [ ] **Step 3: Add canonical object-key helper**

Return exactly:

```text
projects/{projectId}/voices/vi/{segmentId}/{version}.pcm
```

- [ ] **Step 4: Run API tests**

Expected: PASS including binary body byte equality.

- [ ] **Step 5: Commit**

```text
feat(voice): upload versioned client PCM
```

---

### Task 5: Add sequential Vietnamese preload coordinator

**Files:**
- Create: `src/features/voice/clientVoicePreload.ts`
- Create: `src/features/voice/clientVoicePreload.test.ts`

**Interfaces:**
- Consumes: `getTranslationVariants`, `BrowserPiperRuntime`, `decodeWavBlob`, `uploadClientVoicePcm`, canonical object key.
- Produces:

```ts
export type ClientVoicePreloadState =
  | { phase: 'idle' }
  | { phase: 'loading_model'; percent: number | null }
  | { phase: 'synthesizing'; completed: number; total: number; segmentId: string }
  | { phase: 'uploading'; completed: number; total: number; segmentId: string }
  | { phase: 'verifying'; completed: number; total: number }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; total: number };

export async function ensureVietnameseClientVoiceCache(input: {
  projectId: string;
  runtime: BrowserPiperRuntime;
  decodeWav: (wav: Blob) => Promise<Uint8Array>;
  signal?: AbortSignal;
  onState?: (state: ClientVoicePreloadState) => void;
}): Promise<void>;
```

- [ ] **Step 1: Write failing coordinator tests**

Cover:
- already-complete exact-version cache => zero model load/synthesis/upload;
- missing/stale object key => synthesize/upload only misses;
- operations occur sequentially;
- incomplete/empty translation => fail before model call;
- model/synthesis/decode/upload failure => reject and never report ready;
- first 409 `TRANSLATION_VARIANT_CONFLICT` => refetch and retry that segment once with canonical text/version;
- second conflict => fail closed;
- final verification refetch is mandatory and missing/stale row after upload => fail closed;
- abort signal prevents further segments.

- [ ] **Step 2: Implement exact cache predicate**

A row is complete only when translation exists, has non-empty `translatedText`, `translationStatus === 'completed'`, `voiceStatus === 'completed'`, and `dubbedObjectKey` equals the canonical key for current version.

- [ ] **Step 3: Implement sequential preload**

Call `runtime.ensureModel()` only if at least one miss exists. For each miss emit synthesizing -> uploading state, immediately release references after upload, and never accumulate WAV/PCM arrays.

- [ ] **Step 4: Implement one-conflict retry**

Recognize `ApiError` status 409/code `TRANSLATION_VARIANT_CONFLICT`; refetch variants and locate the same segment. Retry exactly once. Do not loop.

- [ ] **Step 5: Run coordinator tests**

Expected: all PASS and no paid provider imports/references.

- [ ] **Step 6: Commit**

```text
feat(voice): preload Vietnamese client voice cache
```

---

### Task 6: Make Vietnamese dubbed availability local-capability aware

**Files:**
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`

**Interfaces:**
- Modify `dubbedAvailability` to accept local capability:

```ts
export function dubbedAvailability(
  capabilities: VoiceCapabilities | null,
  targetLanguage: TargetLanguage,
  localVietnameseSupported = false,
): { allowed: boolean; reason: string };
```

Add optional props:

```ts
clientVoicePreloadState?: ClientVoicePreloadState;
localVietnameseSupported?: boolean;
```

- [ ] **Step 1: Write failing UI admission tests**

Require:
- `vi` + server unconfigured + local supported => allowed;
- `vi` + local unsupported + server unconfigured => blocked with local-browser reason;
- non-`vi` behavior unchanged;
- progress text renders for loading/synthesizing/uploading/verifying/ready;
- active preload disables buttons through existing `busy` prop;
- no paid fallback button/text is introduced.

- [ ] **Step 2: Implement minimal availability change**

For `vi`, local support is an alternate admission path. Do not mutate `VoiceCapabilities` or claim server provider is configured.

- [ ] **Step 3: Add compact progress copy**

Render within existing panel using existing status/error styling where possible; no layout redesign.

- [ ] **Step 4: Run BatchExportPanel tests**

Expected: PASS, non-`vi` assertions unchanged.

- [ ] **Step 5: Commit**

```text
feat(export): expose local Vietnamese voice readiness
```

---

### Task 7: Gate Studio export through browser Piper preload

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/StudioShellTranslationSettings.test.tsx` only if its existing harness needs the new props.

**Interfaces:**
- Consumes `createBrowserPiperRuntime`, `ensureVietnameseClientVoiceCache`, `decodeWavBlob`.
- Existing export APIs remain unchanged.

- [ ] **Step 1: Write RED orchestration tests**

Inject/spy services so tests prove:
- current `vi` dubbed export calls preload before `startLanguageExport`;
- batch containing `vi` calls preload exactly once before `startBatchExport`;
- subtitles do not preload;
- batch without `vi` does not preload;
- retry of failed `vi` dubbed export preloads before retry launch;
- preload failure prevents export API call and surfaces error;
- successful preload launches export exactly once;
- active preload contributes to busy/duplicate-click lock.

- [ ] **Step 2: Add browser decode adapter**

Create a short-lived `AudioContext`, decode the WAV, call `decodeWavBlob`, then close the context in `finally`. Do not play audio.

- [ ] **Step 3: Add `ensureClientVoiceForExport(language)` helper**

Behavior:

```ts
if (exportOutput !== 'dubbed' || language !== 'vi') return;
if (!runtime.isSupported()) throw new Error('Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.');
await ensureVietnameseClientVoiceCache(...);
```

For batch, preload once when `selectedLanguages.includes('vi')`.

- [ ] **Step 4: Wire preload state into `BatchExportPanelView`**

`busy` becomes `exportBusy || preloadActive`; pass local support and current preload state.

- [ ] **Step 5: Ensure zero paid fallback**

On preload failure set `exportError` and return. Never call export APIs as a fallback because server export may select a paid TTS provider.

- [ ] **Step 6: Run Studio/UI tests**

Expected: PASS with exact call ordering assertions.

- [ ] **Step 7: Commit**

```text
feat(studio): preload local Vietnamese voice before export
```

---

### Task 8: Close source contract and full qualification

**Files:**
- Modify only if tests reveal a concrete issue; no speculative refactor.

- [ ] **Step 1: Run source-contract gate**

`npm run verify:deploy-config` must PASS including `tests/browser-piper-voice-preload.test.mjs`.

- [ ] **Step 2: Run full unit/build suite**

`npm run verify` must PASS.

- [ ] **Step 3: Require fresh exact-head GitHub CI**

Require verify/build, checked-in Wrangler dry-run, generated-production Wrangler dry-run, screenshots, and artifact upload all SUCCESS on one exact branch head.

- [ ] **Step 4: Review exact diff**

Confirm:
- no Stream/Container additions;
- no AI Gateway top-up or paid-provider secret/config;
- no automatic Grok/ElevenLabs fallback;
- Piper is lazy-loaded;
- only `vi` bypasses server voice admission through local capability;
- translation version/canonical R2 metadata is authoritative;
- no batch parallel synthesis.

- [ ] **Step 5: Revalidate latest `main`**

If `main` advanced, inspect overlap. Reconcile non-force only, then require a new exact-head full CI.

- [ ] **Step 6: Mark PR Ready and merge with expected head SHA**

Do not merge Draft/RED/stale head.

- [ ] **Step 7: Verify post-merge**

Require `main` GitHub CI plus backend and gateway Workers Builds SUCCESS.

- [ ] **Step 8: Keep issue #91 open**

Record merge/build evidence. Do not dispatch/claim production qualification until an authorized real browser session runs Piper preload on the real H.264 fixture and the final MP4 passes H.264 packet-copy + AAC + playback/reload gates.
