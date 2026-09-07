# Real-Media Production Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, reproducible live-production smoke that uploads real MP4 media, runs dubbing to `needs_review`, exports dubbed MP4, and proves the production R2-backed media response is usable.

**Architecture:** A Node.js runner drives only the deployed public HTTP API and writes a machine-readable summary. A manual GitHub Actions workflow generates a tiny speech MP4 with `espeak-ng` + `ffmpeg`, requires an explicit confirmation input, invokes the runner, and uploads the summary/log evidence. A source-contract test guards the permanent workflow against accidental automatic paid execution and guards the runner sequence without making live requests.

**Tech Stack:** Node.js 24 built-in `fetch`, `node:test`, GitHub Actions, `ffmpeg`, `espeak-ng`, existing Hono production API.

**Spec:** `docs/superpowers/specs/2026-09-07-real-media-production-smoke-design.md`

## Global Constraints

- Permanent workflow must be `workflow_dispatch` only.
- Explicit confirmation must equal `RUN_LIVE_MEDIA_SMOKE` before live provider use.
- Production origin defaults to `https://yupvox.qs3d.site`.
- Export mode is `output=dubbed`, `audioMode=dubbed_only`, `visualMode=standard`.
- Polling must be bounded and terminal failures must fail the workflow.
- Do not add a project deletion endpoint.
- Do not commit media binaries.

---

### Task 1: Source-contract regression guard

**Files:**
- Create: `tests/real-media-smoke.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: repository source files.
- Produces: a local CI gate that requires `scripts/real-media-smoke.mjs` and `.github/workflows/real-media-smoke.yml` to implement the approved contract.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('real-media smoke runner exercises live upload, dubbing, export and media verification', async () => {
  const source = await read('scripts/real-media-smoke.mjs');
  assert.match(source, /\/api\/projects/);
  assert.match(source, /\/uploads/);
  assert.match(source, /\/process/);
  assert.match(source, /needs_review/);
  assert.match(source, /\/exports\/vi/);
  assert.match(source, /exportObjectKey/);
  assert.match(source, /range/i);
  assert.match(source, /timeout/i);
});

test('real-media workflow is permanently manual and requires explicit live confirmation', async () => {
  const source = await read('.github/workflows/real-media-smoke.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s*push:/m);
  assert.match(source, /RUN_LIVE_MEDIA_SMOKE/);
  assert.match(source, /espeak-ng/);
  assert.match(source, /ffmpeg/);
  assert.match(source, /real-media-smoke\.mjs/);
  assert.match(source, /upload-artifact/);
});
```

Add `tests/real-media-smoke.test.mjs` to `verify:deploy-config` in `package.json`.

- [ ] **Step 2: Run test to verify RED**

Run the branch CI after committing only the new test/package script update.
Expected: `verify-build` fails because `scripts/real-media-smoke.mjs` and `.github/workflows/real-media-smoke.yml` do not exist.

- [ ] **Step 3: Commit RED**

Commit message: `test: require real media production smoke`

---

### Task 2: Production smoke runner

**Files:**
- Create: `scripts/real-media-smoke.mjs`

**Interfaces:**
- Consumes env vars `SMOKE_MEDIA_PATH`, optional `SMOKE_BASE_URL`, optional `SMOKE_TIMEOUT_MS`, optional `SMOKE_SUMMARY_PATH`.
- Produces process exit status and JSON summary file.

- [ ] **Step 1: Implement minimal runner**

Use a request helper that throws on unexpected statuses, a bounded `poll` helper, and this public API sequence:

```js
const project = await jsonRequest('/api/projects', {
  method: 'POST',
  body: { title: `e2e-smoke-${Date.now()}`, sourceLanguage: 'en', targetLanguage: 'vi' },
}, [201]);

const upload = await jsonRequest(`/api/projects/${project.id}/uploads`, {
  method: 'POST',
  body: { filename: 'real-media-smoke.mp4', sizeBytes: media.length, contentType: 'video/mp4' },
}, [201]);

const part = await rawRequest(
  `/api/projects/${project.id}/uploads/${upload.uploadId}/parts/1?objectKey=${encodeURIComponent(upload.objectKey)}`,
  { method: 'PUT', body: media, headers: { 'content-type': 'video/mp4' } },
  [200],
).then((response) => response.json());

await jsonRequest(`/api/projects/${project.id}/uploads/${upload.uploadId}/complete`, {
  method: 'POST',
  body: { objectKey: upload.objectKey, parts: [part] },
}, [200]);

const dubbing = await jsonRequest(`/api/projects/${project.id}/process`, { method: 'POST' }, [202]);
```

Poll both job and project; require final project status `needs_review`. Start export with:

```js
const launched = await jsonRequest(`/api/projects/${project.id}/exports/vi`, {
  method: 'POST',
  body: { output: 'dubbed', audioMode: 'dubbed_only', visualMode: 'standard' },
}, [202]);
```

Poll export until `completed`, require a non-empty `exportObjectKey`, fetch media, require `video/mp4`-like content type and non-trivial bytes, check MP4 `ftyp` signature in the initial bytes, then issue `Range: bytes=0-1023` and accept 206 or a valid 200 fallback.

Write summary JSON with ids/statuses/object key/media byte count/content type.

- [ ] **Step 2: Run source-contract test to verify GREEN for runner assertions**

Expected: runner test passes; workflow test still fails because workflow file is absent.

- [ ] **Step 3: Commit runner**

Commit message: `feat: add real media production smoke runner`

---

### Task 3: Manual live qualification workflow

**Files:**
- Create: `.github/workflows/real-media-smoke.yml`

**Interfaces:**
- Consumes manual input `confirmation`.
- Produces generated MP4 fixture and uploaded smoke evidence artifact.

- [ ] **Step 1: Add permanent manual workflow**

```yaml
name: Real media production smoke

on:
  workflow_dispatch:
    inputs:
      confirmation:
        description: 'Type RUN_LIVE_MEDIA_SMOKE to run paid/quota-consuming production providers'
        required: true
        type: string

jobs:
  smoke:
    if: ${{ inputs.confirmation == 'RUN_LIVE_MEDIA_SMOKE' }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install fixture tools
        run: sudo apt-get update && sudo apt-get install -y espeak-ng ffmpeg
      - name: Generate short spoken-English MP4
        run: |
          espeak-ng -w /tmp/smoke.wav 'Hello from the DubFlow real media production smoke test.'
          ffmpeg -y -f lavfi -i color=c=black:s=640x360:r=24 -i /tmp/smoke.wav -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/real-media-smoke.mp4
      - name: Run production smoke
        env:
          SMOKE_MEDIA_PATH: /tmp/real-media-smoke.mp4
          SMOKE_SUMMARY_PATH: real-media-smoke-summary.json
        run: node scripts/real-media-smoke.mjs 2>&1 | tee real-media-smoke.log
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: real-media-production-smoke-${{ github.run_id }}
          path: |
            real-media-smoke-summary.json
            real-media-smoke.log
```

- [ ] **Step 2: Run local/source contract gate**

Expected: `npm run verify:deploy-config` passes.

- [ ] **Step 3: Commit workflow**

Commit message: `ci: add manual real media production smoke`

---

### Task 4: One-time branch qualification

**Files:**
- Temporarily modify then restore: `.github/workflows/real-media-smoke.yml`

**Interfaces:**
- Produces one real GitHub Actions run against production from the feature branch.

- [ ] **Step 1: Add a branch-only temporary push trigger**

Temporarily add:

```yaml
  push:
    branches:
      - feat/real-media-production-smoke-20260907
```

and make the job guard permit that exact branch push while preserving the confirmation requirement for manual runs.

- [ ] **Step 2: Push the temporary qualification commit and inspect the workflow run**

Expected: generated MP4 upload succeeds, dubbing reaches `needs_review`, export reaches `completed`, artifact contains summary with non-empty `exportObjectKey`, media verification succeeds.

- [ ] **Step 3: If live run exposes a production bug, apply normal RED -> GREEN TDD before proceeding**

Do not weaken the smoke to accept the failure.

- [ ] **Step 4: Restore manual-only workflow and verify the source-contract test rejects any remaining `push:` trigger**

Expected: `npm run verify` passes with no automatic trigger.

- [ ] **Step 5: Commit permanent workflow restoration**

Commit message: `ci: keep real media smoke manual only`

---

### Task 5: Review, PR, and merge

**Files:**
- No new files unless review finds a defect.

- [ ] **Step 1: Re-read latest `main` and compare branch drift**

Require no unresolved overlap or stale-base regression.

- [ ] **Step 2: Run final verification on exact head**

Require `npm run verify` / GitHub CI green and permanent workflow manual-only.

- [ ] **Step 3: Open PR**

Title: `test(prod): add real media end-to-end qualification`

Body must describe the live production run evidence and explicitly state the workflow is manual-only because it consumes provider quota and leaves a prefixed smoke project/artifacts.

- [ ] **Step 4: Review changed files and CI**

Do not merge if checks fail or if the workflow still has an automatic trigger.

- [ ] **Step 5: Merge to `main` and verify post-merge CI**

Expected: latest `main` green; real-media workflow available for future manual qualification.
