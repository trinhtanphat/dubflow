# Production Browser Piper Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, verification-only production fixture that drives the deployed Vietnamese browser-Piper lane and proves the final private-R2 MP4 contains AAC dubbed audio while preserving the original H.264 elementary stream.

**Architecture:** Reuse the existing Node production fixture setup for readiness, project creation, multipart upload, processing, durable polling, final download, and ffmpeg/ffprobe proof. The browser-only phase launches the Chrome/Chromium binary already present on the GitHub-hosted runner and controls the deployed Studio directly through Chrome DevTools Protocol (CDP) using only Node 22 built-ins; no Playwright, Puppeteer, Selenium, runtime endpoint, or application dependency is added.

**Tech Stack:** Node 22 built-ins (`fetch`, `WebSocket`, `child_process`, `fs`), system Chrome/Chromium, existing production REST API, GitHub Actions `workflow_dispatch`, ffmpeg/ffprobe.

**Spec:** `docs/superpowers/specs/2026-09-07-production-browser-piper-fixture-design.md`

## Global Constraints

- Production origin is exactly `https://yupvox.qs3d.site`.
- GitHub Actions is verification-only and must never deploy production.
- Cloudflare Workers Builds remains the only production deploy lane.
- Workflow remains `workflow_dispatch` only.
- No Cloudflare Stream or Containers.
- No AI Gateway top-up and no paid Google, ElevenLabs, Grok, or Deepgram activation.
- Vietnamese voice generation must run through the deployed browser Piper path from #122.
- No Playwright, Puppeteer, Selenium, browser extension, public debug endpoint, or application/runtime dependency.
- `package.json` must end identical to base `70bf0bb4423886e5f639cb33cee0d8ffbc5374c3`.
- #128 remains Draft after media PASS until canonical `MEDIA_SOURCE_SIGNING_SECRET` provenance is separately proven live.

---

### Task 1: Lock the native-CDP source contract

**Files:**
- Modify: `tests/production-browser-piper-fixture.test.mjs`
- Modify: `tests/production-media-fixture.test.mjs`
- Revert-only: `package.json`

**Interfaces:**
- Consumes: `.github/workflows/production-media-fixture.yml`, `scripts/verify-production-browser-piper-fixture.mjs`.
- Produces: CI-enforced source checks without changing package scripts or dependencies.

- [ ] **Step 1: Keep the RED contract focused on missing workflow integration**

The browser fixture source test must require all of these concrete markers:

```js
assert.match(workflow, /workflow_dispatch/);
assert.match(workflow, /verify-production-browser-piper-fixture\.mjs/);
assert.doesNotMatch(workflow, /playwright|puppeteer|selenium|wrangler\s+deploy|PAID_[A-Z0-9_]*\s*=\s*true|CLOUDFLARE_STREAM|FFMPEG_CONTAINER/i);
assert.match(runner, /--remote-debugging-port=0/);
assert.match(runner, /new WebSocket\s*\(/);
assert.match(runner, /Network\.requestWillBeSent/);
assert.match(runner, /Page\.reload/);
assert.match(runner, /data-testid=["']export-current-language["']/);
assert.match(runner, /PRODUCTION_MEDIA_OUTPUT_PATH/);
assert.doesNotMatch(runner, /\/api\/voice\/capabilities|xai\/grok-tts|ElevenLabs|Deepgram|PAID_/i);
```

Add a contract that the export control is polled until enabled rather than failing merely because it initially exists disabled:

```js
assert.match(runner, /button[^\n]*&&\s*!button\.disabled/);
```

- [ ] **Step 2: Make the existing production fixture Node test load the browser contract**

At the top of `tests/production-media-fixture.test.mjs`, import the browser contract:

```js
import './production-browser-piper-fixture.test.mjs';
```

Update its workflow assertions so the manual workflow is expected to invoke `verify-production-browser-piper-fixture.mjs`, while the legacy server fixture script remains checked in as historical/diagnostic source and is not used by the manual workflow.

- [ ] **Step 3: Restore package.json exactly to base**

Remove the temporary explicit `tests/production-browser-piper-fixture.test.mjs` entry from `verify:deploy-config`; CI reaches the contract through the existing `tests/production-media-fixture.test.mjs` import.

- [ ] **Step 4: Run the focused Node tests**

Run:

```bash
node --test tests/production-media-fixture.test.mjs
```

Expected before workflow wiring: FAIL only because the workflow still invokes the legacy server fixture and/or the enabled-button contract is not satisfied.

### Task 2: Harden the native-CDP runner

**Files:**
- Modify: `scripts/verify-production-browser-piper-fixture.mjs`
- Test: `tests/production-browser-piper-fixture.test.mjs`

**Interfaces:**
- Consumes: `PRODUCTION_MEDIA_FIXTURE_PATH`, `PRODUCTION_MEDIA_OUTPUT_PATH`, optional `PRODUCTION_BROWSER_EXECUTABLE`.
- Produces: final JSON PASS with `projectId`, `processJobId`, `exportId`, `exportJobId`, source/output bytes, content type, ASR provider, and browser-Piper voice lane.

- [ ] **Step 1: Keep server setup fail-closed and zero-cost**

The runner must:

```text
GET  /api/ready
POST /api/projects                         { sourceLanguage: "en", targetLanguage: "vi" }
POST /api/projects/:id/uploads
PUT  /api/projects/:id/uploads/:uploadId/parts/:part?objectKey=...
POST /api/projects/:id/uploads/:uploadId/complete
POST /api/projects/:id/process
GET  /api/projects/:id/jobs/:jobId
GET  /api/projects/:id/translations/vi
```

Require schema revision 14, R2 ready, remux ready, and ASR provider `workers-ai-whisper-large-v3-turbo`. Do not call `/api/voice/capabilities`.

- [ ] **Step 2: Keep Chromium/CDP dependency-free**

Resolve an existing Chrome/Chromium executable, spawn it with an isolated temporary profile plus:

```text
--headless=new
--no-sandbox
--disable-dev-shm-usage
--remote-debugging-port=0
--remote-allow-origins=*
```

Read `DevToolsActivePort`, connect to the page target with Node's built-in `WebSocket`, and enable `Page`, `Runtime`, and `Network`.

- [ ] **Step 3: Wait for the real export button to become enabled**

After opening the `Ngôn ngữ & export` details element, poll the deployed button and return a truthy value only when it both exists and is enabled:

```js
(() => {
  const button = document.querySelector('[data-testid="export-current-language"]');
  if (!button || button.disabled) return null;
  return { text: button.textContent?.trim() ?? '', disabled: false };
})()
```

If the deployed UI surfaces `.batch-export__error`, fail with that visible error and sanitized CDP diagnostics rather than falling back to server TTS.

- [ ] **Step 4: Observe the exact UI-triggered export POST**

Register CDP `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, and `Network.loadingFailed` listeners before the click. Accept only:

```text
POST https://yupvox.qs3d.site/api/projects/:projectId/exports/vi
```

Read the response body with `Network.getResponseBody` and require 2xx plus non-empty `exportId` and `jobId`. Node must not POST this export endpoint directly.

- [ ] **Step 5: Prove exact-version PCM before accepting the launch**

After the browser-triggered POST returns, fetch `/translations/vi` through the normal production API and require every row to have:

```text
translationStatus = completed
translatedText non-empty
version >= 1
voiceStatus = completed
dubbedObjectKey = projects/:projectId/voices/vi/:segmentId/:version.pcm
```

- [ ] **Step 6: Prove reload durability**

Issue CDP `Page.reload`, wait for the deployed page to load, then run a same-origin page `fetch('/api/projects/:id/exports/vi?output=dubbed')`. Require HTTP 200 and the same export id returned by the UI-triggered POST.

- [ ] **Step 7: Persist final MP4**

After browser close, poll the latest per-language export until `completed`; fail immediately on `failed` or `invalidated`. Download `/api/projects/:id/exports/vi/media?output=dubbed`, require `video/mp4` and the MP4 `ftyp` marker, then write `PRODUCTION_MEDIA_OUTPUT_PATH`.

- [ ] **Step 8: Run the focused Node tests GREEN**

Run:

```bash
node --test tests/production-media-fixture.test.mjs
```

Expected after Task 3 workflow wiring: PASS.

### Task 3: Wire the manual workflow and preserve media proof

**Files:**
- Modify: `.github/workflows/production-media-fixture.yml`
- Test: `tests/production-media-fixture.test.mjs`

**Interfaces:**
- Consumes: deterministic generated H.264/AAC speech fixture and the runner's system Chrome discovery.
- Produces: output MP4 checked by ffprobe and H.264 elementary-stream SHA.

- [ ] **Step 1: Keep fixture generation unchanged**

Continue installing only `ffmpeg` and `espeak-ng`, then generate the deterministic 12-second baseline H.264/AAC MP4. Do not install any npm browser driver.

- [ ] **Step 2: Switch the verification step to the browser runner**

Keep:

```yaml
PRODUCTION_MEDIA_FIXTURE_PATH: ${{ runner.temp }}/production-r2-fixture.mp4
PRODUCTION_MEDIA_OUTPUT_PATH: ${{ runner.temp }}/production-r2-output.mp4
```

Run exactly:

```bash
node scripts/verify-production-browser-piper-fixture.mjs
```

- [ ] **Step 3: Preserve the existing final gates byte-for-byte where possible**

Require with `ffprobe`:

```text
video codec = h264
audio codec = aac
```

Extract both source and output H.264 elementary streams using `-c:v copy -bsf:v h264_mp4toannexb -f h264`, SHA-256 both files, and require equality.

- [ ] **Step 4: Run full source verification**

Run through CI:

```text
agent coordination
npm run verify
wrangler dry-run
generated-production wrangler dry-run
reference screenshots
artifact upload
```

All must be terminal SUCCESS on the exact PR head.

### Task 4: Merge and runtime qualification

**Files:**
- PR metadata / issue state only.

**Interfaces:**
- Consumes: exact-head CI, stable main, exact-SHA Cloudflare Workers Builds, manual production fixture.
- Produces: source-qualified merged carrier; #91 closes only on real browser E2E PASS.

- [ ] **Step 1: Revalidate exact head and main drift**

Require PR mergeable, non-stale base with no overlapping drift, and exact head unchanged after terminal GREEN CI.

- [ ] **Step 2: Mark Ready and merge expected head only**

Use the exact PR head SHA as the merge precondition; do not merge RED or moved head.

- [ ] **Step 3: Require post-merge stability before the live fixture**

On the exact merge SHA require:

```text
GitHub CI = SUCCESS
Cloudflare Workers Build dubflow = SUCCESS
Cloudflare Workers Build dubflow-gateway = SUCCESS
```

Do not run the production fixture before both production builds are stable.

- [ ] **Step 4: Manually dispatch Production R2 Media Fixture**

A runtime PASS must prove:

```text
schema-14 R2/remux readiness
Workers AI ASR
real H.264 upload + processing
completed Vietnamese translations
real production Studio browser Piper
exact-version PCM durability
UI-triggered /exports/vi POST
same export identity after browser reload
completed private-R2 dubbed MP4
H.264 + AAC
source/output H.264 packet SHA equality
```

- [ ] **Step 5: Update runtime truth**

Close #91 only if every runtime gate passes. On any failure keep #91 open, record the exact stage/code, and fix in a new RED→GREEN carrier without enabling paid resources. Keep #128 Draft until canonical signing-secret provenance is separately verified live.
