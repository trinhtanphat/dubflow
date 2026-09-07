# Browser Piper Zero-Cost Vietnamese Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD is mandatory: every production behavior starts with a failing test whose failure is verified before implementation.

**Goal:** Let Vietnamese dubbed exports prepare exact-version client PCM in the browser with Piper, upload it through the existing #113 endpoint, and launch the existing R2-only export only after every Vietnamese translation has a durable exact-version voice artifact.

**Architecture:** Add a lazy browser Piper Web Worker, a pure WAV-to-24k-s16le converter, a binary client-voice API helper, and a version-aware preload orchestrator. `StudioShell.tsx` owns orchestration; `BatchExportPanel.tsx` only reflects whether the Vietnamese client lane is available/preparing. Server provider behavior for non-Vietnamese targets remains unchanged. No automatic paid fallback is introduced.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7 module workers, Vitest 3, `@mintplex-labs/piper-tts-web@1.0.5`, existing Hono/Cloudflare backend API.

**Spec:** `docs/superpowers/specs/2026-09-07-browser-piper-zero-cost-voice-design.md`

## Global Constraints

- No Cloudflare Stream or Containers.
- No AI Gateway credit/top-up, new provider secret, or automatic Grok/ElevenLabs fallback.
- Client synthesis is qualified only for `vi`.
- Piper voice is fixed to `vi_VN-vais1000-medium`.
- Piper package is pinned exactly to `1.0.5`; this repository currently has no lockfile and this carrier does not introduce a new lockfile policy.
- Backend PCM contract remains raw little-endian signed-16-bit mono at exactly 24,000 Hz, maximum 8 MiB per segment.
- Translation version is authoritative. Stale text/audio must never be accepted as current.
- Missing browser primitives, model/runtime download failure, synthesis failure, conversion failure, upload failure, or post-upload cache mismatch must stop before export launch.
- Subtitle flows and non-Vietnamese server-provider flows remain behaviorally unchanged.
- Issue #91 remains open after merge until a real production browser-driven H.264 → client PCM → dubbed R2 MP4 fixture passes.

---

### Task 1: Lock the browser-Piper RED contract

**Files:**
- Create: `tests/browser-piper-zero-cost-voice.test.mjs`
- Modify: `package.json`

**RED acceptance contract:**

```js
const [pkg, panel, shell, preload, worker] = await Promise.all([
  source('../package.json'),
  source('../src/features/export/BatchExportPanel.tsx'),
  source('../src/app/StudioShell.tsx'),
  source('../src/features/voice/clientVoicePreload.ts'),
  source('../src/features/voice/browserPiper.worker.ts'),
]);

assert.match(pkg, /"@mintplex-labs\/piper-tts-web"\s*:\s*"1\.0\.5"/);
assert.match(worker, /vi_VN-vais1000-medium/);
assert.match(preload, /preloadVietnameseVoices/);
assert.match(shell, /preloadVietnameseVoices/);
assert.match(panel, /clientVoiceAvailable/);
```

- [ ] Add a Node source-contract test that locks exact Piper package/voice, lazy worker file, preload orchestration, Studio integration, client-lane availability in export admission, and fail-closed absence of paid/Stream/Container references in the new browser voice files.
- [ ] Append `tests/browser-piper-zero-cost-voice.test.mjs` to `verify:deploy-config` without removing existing gates.
- [ ] Commit only test/manifest-script wiring; do **not** add Piper dependency or production files yet.
- [ ] Open a draft PR from the feature branch after this RED commit.
- [ ] Require fresh CI to fail in `Verify source and production build` because the new source contract is absent. Record the exact run/job and confirm the failure is the intended new test rather than an unrelated baseline failure.

**Commit:** `test(voice): lock browser Piper zero-cost contract`

---

### Task 2: Add exact dependency and deterministic WAV → PCM conversion

**Files:**
- Modify: `package.json`
- Create: `src/features/voice/clientPcm.ts`
- Create: `src/features/voice/clientPcm.test.ts`

**Public interface:**

```ts
export const CLIENT_PCM_SAMPLE_RATE = 24_000;
export const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;

export function wavToClientPcm(input: ArrayBuffer): Uint8Array;
```

**Implementation rules:**

- Parse `RIFF` / `WAVE` and scan chunks by chunk id; do not assume a 44-byte header.
- Read `fmt ` before interpreting `data`.
- Accept mono PCM format `1` with 16-bit samples and mono IEEE-float format `3` with 32-bit samples, which covers the known Piper WAV path; reject any other encoding, channel count, invalid sample rate, malformed/truncated chunk, or empty audio.
- Convert source samples to normalized floats, linearly resample to 24,000 Hz, clamp to `[-1, 1]`, and encode signed 16-bit little-endian.
- Reject empty, odd-length, or >8 MiB output.

**Representative tests:**

```ts
it('resamples a mono 22050 Hz PCM WAV to 24000 Hz s16le', () => {
  const wav = makeMonoPcm16Wav({ sampleRate: 22_050, samples: [0, 8192, -8192, 0] });
  const pcm = wavToClientPcm(wav);
  expect(pcm.byteLength).toBeGreaterThan(0);
  expect(pcm.byteLength % 2).toBe(0);
});

it('finds fmt/data chunks when a metadata chunk is inserted', () => {
  expect(() => wavToClientPcm(makeWavWithJunkChunk())).not.toThrow();
});

it('rejects stereo or compressed WAV input', () => {
  expect(() => wavToClientPcm(makeStereoWav())).toThrow(/mono/i);
});
```

- [ ] Write PCM tests first and verify they fail because `clientPcm.ts` is absent.
- [ ] Add exact dependency `"@mintplex-labs/piper-tts-web": "1.0.5"` under `dependencies`.
- [ ] Implement the smallest converter satisfying the tests.
- [ ] Run the focused Vitest file and then the full test suite through CI later; do not initialize Piper in these unit tests.

**Commit:** `feat(voice): add deterministic client PCM conversion`

---

### Task 3: Add the bounded binary upload API client

**Files:**
- Create: `src/features/voice/clientVoiceApi.ts`
- Create: `src/features/voice/clientVoiceApi.test.ts`

**Interface:**

```ts
export type ClientVoiceUploadDto = {
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: string;
  objectKey: string | null;
};

export function uploadVietnameseVoicePcm(
  projectId: string,
  segmentId: string,
  version: number,
  pcm: Uint8Array,
  fetchImpl?: typeof fetch,
): Promise<ClientVoiceUploadDto>;
```

**Request contract:**

```ts
const path = `/api/projects/${encodeURIComponent(projectId)}`
  + `/translations/vi/${encodeURIComponent(segmentId)}/voice-pcm`;

headers: {
  'content-type': 'application/octet-stream',
  'X-DubFlow-PCM-Format': 's16le',
  'X-DubFlow-PCM-Sample-Rate': '24000',
  'X-DubFlow-PCM-Channels': '1',
  'X-DubFlow-Translation-Version': String(version),
}
```

- [ ] RED-test exact encoded URL, all five required headers, and exact binary body bytes.
- [ ] RED-test invalid local version/body admission (`version < 1`, empty, odd, >8 MiB) before fetch.
- [ ] RED-test a backend 409 `TRANSLATION_VARIANT_CONFLICT` remains an `ApiError` and is not converted into a success/retry.
- [ ] Implement using existing `apiFetch`, explicitly overriding its JSON default `content-type`.
- [ ] Do not add provider/fallback logic here.

**Commit:** `feat(voice): add client PCM upload API`

---

### Task 4: Add typed Piper worker protocol and reusable worker client

**Files:**
- Create: `src/features/voice/browserPiperProtocol.ts`
- Create: `src/features/voice/browserPiperClient.ts`
- Create: `src/features/voice/browserPiperClient.test.ts`
- Create: `src/features/voice/browserPiper.worker.ts`

**Constants and protocol:**

```ts
export const VIETNAMESE_PIPER_VOICE = 'vi_VN-vais1000-medium' as const;

export type PiperWorkerRequest =
  | { type: 'init' }
  | { type: 'synthesize'; requestId: string; text: string };

export type PiperWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; requestId?: string; loaded?: number; total?: number }
  | { type: 'result'; requestId: string; pcm: ArrayBuffer }
  | { type: 'error'; requestId?: string; code: string; message: string };
```

**Browser capability:**

```ts
export function browserPiperAvailable(): boolean {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function';
}
```

**Worker runtime:**

```ts
import { TtsSession } from '@mintplex-labs/piper-tts-web';

let session: TtsSession | null = null;

async function ensureSession() {
  if (!session) {
    session = await TtsSession.create({ voiceId: VIETNAMESE_PIPER_VOICE, progress: postProgress });
  }
  return session;
}
```

On `synthesize`, call `session.predict(text)`, convert the returned WAV Blob with `wavToClientPcm(await blob.arrayBuffer())`, and `postMessage({ type:'result', requestId, pcm: pcmBuffer }, [pcmBuffer])`.

**Main-thread client rules:**

- Construct lazily with `new Worker(new URL('./browserPiper.worker.ts', import.meta.url), { type: 'module' })`.
- Reuse one worker instance for all sequential requests.
- Maintain one pending request at a time; correlate terminal result/error by `requestId`.
- Initialization error rejects and marks the client attempt unavailable; it must not silently create a second provider path.
- `dispose()` terminates worker and rejects any pending request.

- [ ] RED-test capability detection with missing Worker/WebAssembly/OPFS cases.
- [ ] RED-test a fake worker receives one `init`, then sequential `synthesize` messages, and one worker instance is reused.
- [ ] RED-test mismatched request IDs are not accepted as the active request result.
- [ ] RED-test `error` rejects the request and no retry/provider call happens inside the client.
- [ ] Implement protocol/client, then worker runtime importing Piper only from `.worker.ts`.
- [ ] Ensure tests do not import/execute the browser-only Piper runtime.

**Commit:** `feat(voice): add lazy Piper worker runtime`

---

### Task 5: Add exact-version Vietnamese preload orchestration

**Files:**
- Create: `src/features/voice/clientVoicePreload.ts`
- Create: `src/features/voice/clientVoicePreload.test.ts`

**Interfaces:**

```ts
export type ClientVoiceProgress =
  | { stage: 'loading-model'; loaded?: number; total?: number }
  | { stage: 'synthesizing'; index: number; total: number; segmentId: string }
  | { stage: 'uploading'; index: number; total: number; segmentId: string }
  | { stage: 'verifying'; total: number };

export function targetVietnameseVoiceKey(
  projectId: string,
  segmentId: string,
  version: number,
): string;

export function isExactVietnameseVoiceCached(
  projectId: string,
  row: TranslationVariantDto,
): boolean;

export async function preloadVietnameseVoices(
  projectId: string,
  deps: ClientVoicePreloadDeps,
  onProgress?: (progress: ClientVoiceProgress) => void,
): Promise<TranslationVariantDto[]>;
```

**Dependency boundary:**

```ts
export type ClientVoicePreloadDeps = {
  fetchVariants: (projectId: string) => Promise<TranslationVariantDto[]>;
  synthesize: (text: string, onProgress?: (loaded?: number, total?: number) => void) => Promise<Uint8Array>;
  upload: (projectId: string, segmentId: string, version: number, pcm: Uint8Array) => Promise<ClientVoiceUploadDto>;
};
```

**Algorithm:**

1. Fetch canonical `vi` rows fresh.
2. Require at least one row and every row to have a completed, non-empty `vi` translation with a positive integer version.
3. Filter rows where `voiceStatus !== 'completed'` or `dubbedObjectKey !== targetVietnameseVoiceKey(...)`.
4. If none are missing/stale, return immediately without calling synthesize/upload.
5. For each missing/stale row in input order, `await` synthesize then `await` upload. Never use `Promise.all` for inference.
6. Require each upload response to match `segmentId`, version, completed status, and exact object key.
7. Fetch canonical rows again and require every row to be exact-cache complete.
8. Return verified rows. Any error rejects and therefore prevents the caller from launching export.

- [ ] RED-test exact-cache skip with zero synth/upload calls.
- [ ] RED-test only missing/stale rows are generated.
- [ ] RED-test sequential ordering by resolving each fake synthesis manually.
- [ ] RED-test exact current version is passed to every upload.
- [ ] RED-test one synthesis/upload failure stops later work.
- [ ] RED-test post-upload refetch is mandatory and stale/missing post-state rejects.
- [ ] Implement minimal orchestration.

**Commit:** `feat(voice): preload exact Vietnamese client voices`

---

### Task 6: Make export presentation aware of the Vietnamese client lane

**Files:**
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batch-export.css` only if needed for the one status line.

**API adjustment:**

```ts
export function dubbedAvailability(
  capabilities: VoiceCapabilities | null,
  targetLanguage: TargetLanguage,
  clientVoiceAvailable = false,
): { allowed: boolean; reason: string } {
  if (targetLanguage === 'vi' && clientVoiceAvailable) return { allowed: true, reason: '' };
  // existing server-provider checks unchanged
}
```

Add props:

```ts
clientVoiceAvailable?: boolean;
clientVoiceStatus?: string;
```

- [ ] RED-test `vi` remains enabled when server `configured=false` but `clientVoiceAvailable=true`.
- [ ] RED-control: `en/zh/ja/ko` remain blocked by the same server-provider rules when server is unconfigured.
- [ ] RED-test `vi` is blocked when both server provider and client lane are unavailable.
- [ ] RED-test batch selection applies client admission only to `vi`; one unsupported non-vi selection still blocks batch export.
- [ ] Render a short status line only when `clientVoiceStatus` is non-empty; do not redesign the panel.
- [ ] Preserve separated-background and lip-sync gates exactly.

**Commit:** `feat(export): admit Vietnamese browser voice lane`

---

### Task 7: Integrate fail-closed preload into Studio export orchestration

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx` or create focused `src/app/StudioShellClientVoice.test.tsx`

**Studio state:**

```ts
const [clientVoiceState, setClientVoiceState] = useState<'available' | 'preparing' | 'unavailable'>(
  () => browserPiperAvailable() ? 'available' : 'unavailable',
);
const [clientVoiceStatus, setClientVoiceStatus] = useState('');
```

Create one lazily reused `BrowserPiperClient` for the mounted Studio; terminate it on unmount.

**Current-language flow:**

```ts
if (exportOutput === 'dubbed' && exportTarget === 'vi') {
  const verified = await prepareVietnameseClientVoice();
  if (currentLanguage === 'vi') setTargetSegments(verified);
}
const result = await startLanguageExport(...);
```

`prepareVietnameseClientVoice()` wires:

- `getTranslationVariants(projectId, 'vi')`
- lazily created `BrowserPiperClient.synthesize`
- `uploadVietnameseVoicePcm`
- progress → concise Vietnamese status text.

**Batch flow:**

- If `exportOutput === 'dubbed' && selectedLanguages.includes('vi')`, preload/verify `vi` first.
- Do not preload for subtitles or a batch without `vi`.
- After successful preload, call the existing `startBatchExport` once with the original selected languages.

**Failure behavior:**

- Any preload error sets `exportError`, returns from the handler, and never calls `startLanguageExport` / `startBatchExport`.
- Initialization failure marks client lane unavailable for the current mounted Studio attempt; there is no automatic server-TTS retry inside the same zero-cost action.
- Existing `exportBusy` wraps the whole preload + export launch sequence.

- [ ] RED-test current `vi` dubbed export calls fresh fetch → synth/upload → post-verify fetch → export in order.
- [ ] RED-test one preload failure means export API call count is zero.
- [ ] RED-test exact-complete cache means export occurs without constructing/using Piper.
- [ ] RED-test subtitles bypass Piper.
- [ ] RED-test batch preloads only `vi`, then launches existing batch request once.
- [ ] RED-control non-vi current export remains on existing server-provider flow.
- [ ] Implement the minimal Studio integration and pass `clientVoiceAvailable/clientVoiceStatus` into `BatchExportPanelView`.

**Commit:** `feat(studio): preload browser Piper voice before export`

---

### Task 8: Full exact-head qualification and integration

**Files:** no intended production changes unless verification finds a proven defect.

- [ ] Run fresh exact-head CI on the implementation PR.
- [ ] Require `Verify source and production build` PASS, which includes `npm run verify`, Vitest, TypeScript, Vite bundle, and all Node acceptance gates.
- [ ] Require checked-in Wrangler dry-run PASS.
- [ ] Require generated-production Wrangler dry-run PASS.
- [ ] Require all reference screenshots and artifact upload PASS.
- [ ] Confirm the Production R2 Media Fixture did **not** auto-run; it remains manual-only.
- [ ] List exact changed files and review every browser-voice file for forbidden active references: Cloudflare Stream, Containers, AI Gateway top-up/credits, Grok inference, ElevenLabs fallback, secrets, or deploy commands.
- [ ] Verify Piper model assets were not copied into repository/public/R2/Worker config.
- [ ] Fetch latest `main` immediately before merge and compare it with the PR head. If main has moved, reconcile non-force and require a new exact-head CI.
- [ ] Ensure zero unresolved review threads and PR is mergeable/ready.
- [ ] Merge with `expected_head_sha` only after all gates are green.
- [ ] Verify `main` equals the returned merge SHA and run fresh post-merge CI to success.
- [ ] Comment issue #91 with source/CI/deploy-safe evidence, explicitly keep it OPEN/UNQUALIFIED until the manual browser-driven production H.264 fixture reaches final H.264/AAC private-R2 MP4 PASS.

## Completion Criteria

This carrier is complete only when the browser Piper source is merged with fresh exact-head and post-merge CI green, the zero-cost fail-closed contract is demonstrably preserved, and #91 records the remaining manual production qualification. Do not claim production E2E qualification from source/CI success alone.
