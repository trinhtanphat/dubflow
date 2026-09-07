# Production Browser Piper Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, verification-only production fixture that drives the deployed browser Piper Vietnamese lane and proves the final R2 MP4 preserves H.264 video while carrying AAC dubbed audio.

**Architecture:** Keep server setup and final artifact checks in a Node runner, but use real Chromium controlled by pinned `playwright-core@1.63.0` for the one operation that must happen in a browser: production Studio exact-cache/Piper preload and per-language export launch. Do not add runtime endpoints or test hooks.

**Tech Stack:** Node 22, `playwright-core@1.63.0` installed `--no-save` in the manual workflow, system Chrome/Chromium, existing production REST API, ffmpeg/ffprobe.

**Spec:** `docs/superpowers/specs/2026-09-07-production-browser-piper-fixture-design.md`

## Global Constraints

- Production origin is `https://yupvox.qs3d.site`.
- GitHub Actions remains verification-only; no workflow deploy command.
- No Cloudflare Stream or Containers.
- No AI Gateway top-up or paid-provider activation.
- Vietnamese TTS must be executed by the deployed browser Piper Studio path.
- The workflow remains `workflow_dispatch` only.
- #128 remains blocked after media qualification until canonical signing-secret provenance is independently verified live.

---

### Task 1: Lock the browser-production fixture contract

**Files:**
- Create: `tests/production-browser-piper-fixture.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `.github/workflows/production-media-fixture.yml`, `scripts/verify-production-browser-piper-fixture.mjs`.
- Produces: a source contract included in `npm run verify:deploy-config`.

- [ ] **Step 1: Write the failing source contract**

Create a Node test that reads the manual workflow and browser runner and requires:

```js
assert.match(workflow, /workflow_dispatch/);
assert.match(workflow, /playwright-core@1\.63\.0/);
assert.match(workflow, /verify-production-browser-piper-fixture\.mjs/);
assert.doesNotMatch(workflow, /wrangler\s+deploy|PAID_.*=true|CLOUDFLARE_STREAM|FFMPEG_CONTAINER/i);
assert.match(runner, /\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
assert.match(runner, /data-testid=["']export-current-language["']/);
assert.match(runner, /exports\/vi/);
assert.match(runner, /page\.reload\s*\(/);
assert.match(runner, /PRODUCTION_MEDIA_OUTPUT_PATH/);
```

Update `verify:deploy-config` to include `tests/production-browser-piper-fixture.test.mjs`.

- [ ] **Step 2: Run the source contract and verify RED**

Run:

```bash
node --test tests/production-browser-piper-fixture.test.mjs
```

Expected: FAIL because the browser runner/workflow integration does not exist yet.

- [ ] **Step 3: Commit RED**

```bash
git add tests/production-browser-piper-fixture.test.mjs package.json
git commit -m "test(prod): require browser Piper fixture"
```

### Task 2: Add the browser-driven production runner

**Files:**
- Create: `scripts/verify-production-browser-piper-fixture.mjs`
- Test: `tests/production-browser-piper-fixture.test.mjs`

**Interfaces:**
- Consumes environment variables `PRODUCTION_MEDIA_FIXTURE_PATH`, `PRODUCTION_MEDIA_OUTPUT_PATH`, optional `PRODUCTION_BROWSER_EXECUTABLE`.
- Produces a terminal JSON PASS line containing `projectId`, process job id, export id/job id, source/output bytes, and content type.

- [ ] **Step 1: Implement shared request/poll helpers**

Implement JSON request handling with bounded polling. Treat project job states `failed` and `cancelled`, and export states `failed` and `invalidated`, as immediate terminal failures with durable error code/message included.

- [ ] **Step 2: Implement production setup**

Perform:

```text
GET /api/ready
POST /api/projects                  { title, sourceLanguage: "en", targetLanguage: "vi" }
POST /api/projects/:id/uploads
PUT  /api/projects/:id/uploads/:uploadId/parts/:partNumber?objectKey=...
POST /api/projects/:id/uploads/:uploadId/complete
POST /api/projects/:id/process
GET  /api/projects/:id/jobs/:jobId  until needs_review/completed
GET  /api/projects/:id/translations/vi
```

Require schema revision 14, R2 ready, remux ready, and at least one completed Vietnamese translation with non-empty text and positive integer version.

- [ ] **Step 3: Launch production Studio in system Chromium**

Resolve Chrome from `PRODUCTION_BROWSER_EXECUTABLE` first, then known GitHub runner locations/`which` candidates. Import `chromium` from `playwright-core`, launch with `executablePath` and `--no-sandbox`, and navigate to:

```js
`${origin}/projects/${encodeURIComponent(projectId)}`
```

Capture `console` and `pageerror` events into bounded diagnostic arrays for failure messages.

- [ ] **Step 4: Trigger the real browser Piper export path**

Open the Studio `details` element whose summary is `Ngôn ngữ & export`, wait for `[data-testid="export-current-language"]` to become enabled, and register `page.waitForResponse()` for the exact production request:

```text
POST /api/projects/:projectId/exports/vi
```

Click the button only after the response waiter is installed. Require a 2xx response with `exportId` and `jobId`. Do not call any server voice capability endpoint and do not call the export POST directly from Node.

- [ ] **Step 5: Prove reload durability**

Call `page.reload()`, then execute same-origin `fetch('/api/projects/:id/exports/vi?output=dubbed')` in page context. Require HTTP 200 and `attempt.id === exportId` from the launch response.

- [ ] **Step 6: Poll and persist final media**

After browser close, poll `/api/projects/:id/exports/vi?output=dubbed` until `completed`. Download `/api/projects/:id/exports/vi/media?output=dubbed`, require `video/mp4` and an `ftyp` box, and write bytes to `PRODUCTION_MEDIA_OUTPUT_PATH`.

- [ ] **Step 7: Run source contract GREEN**

Run:

```bash
node --test tests/production-browser-piper-fixture.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit runner**

```bash
git add scripts/verify-production-browser-piper-fixture.mjs tests/production-browser-piper-fixture.test.mjs package.json
git commit -m "test(prod): drive browser Piper fixture"
```

### Task 3: Wire the manual workflow and media proof

**Files:**
- Modify: `.github/workflows/production-media-fixture.yml`
- Test: `tests/production-browser-piper-fixture.test.mjs`

**Interfaces:**
- Consumes system Chrome already present on the GitHub runner and generated fixture MP4.
- Produces final MP4 evidence checked by ffprobe and H.264 packet SHA.

- [ ] **Step 1: Install pinned browser driver without production dependency changes**

After normal checkout/setup, add:

```bash
npm install --no-save --no-audit --no-fund playwright-core@1.63.0
```

Do not run `playwright install`; use the Chrome/Chromium already available on the hosted runner.

- [ ] **Step 2: Replace server-voice runner with browser runner**

Keep the existing deterministic ffmpeg/espeak fixture generation and set:

```yaml
PRODUCTION_MEDIA_FIXTURE_PATH: ${{ runner.temp }}/production-r2-fixture.mp4
PRODUCTION_MEDIA_OUTPUT_PATH: ${{ runner.temp }}/production-r2-output.mp4
```

Run:

```bash
node scripts/verify-production-browser-piper-fixture.mjs
```

- [ ] **Step 3: Preserve codec and packet checks**

Keep the existing ffprobe checks requiring `h264` and `aac`, extract the input/output H.264 elementary streams with stream copy, and require identical SHA-256 values.

- [ ] **Step 4: Run full source verification**

Run:

```bash
npm install --no-audit --no-fund
npm run verify
npx wrangler deploy --dry-run
node --input-type=module -e "import('./scripts/cloudflare-workers-build-config.mjs').then(({ prepareWorkersBuildConfig }) => prepareWorkersBuildConfig())"
npx wrangler deploy --dry-run --config .wrangler-production.json
```

Expected: all PASS.

- [ ] **Step 5: Commit workflow**

```bash
git add .github/workflows/production-media-fixture.yml
git commit -m "test(prod): wire browser Piper qualification"
```

### Task 4: PR qualification and production runtime gate

**Files:**
- Update PR metadata only; no source file required.

**Interfaces:**
- Consumes exact-head CI and stable current `main`.
- Produces one merged verification-only carrier and one manual production E2E result.

- [ ] **Step 1: Open one Draft PR for issue #91**

Reserve only:

```text
.github/workflows/production-media-fixture.yml
scripts/verify-production-browser-piper-fixture.mjs
tests/production-browser-piper-fixture.test.mjs
package.json
docs/superpowers/specs/2026-09-07-production-browser-piper-fixture-design.md
docs/superpowers/plans/2026-09-07-production-browser-piper-fixture.md
```

Declare `Paid-Resources: FORBIDDEN` and note #128 remains blocked.

- [ ] **Step 2: Require fresh exact-head FULL GREEN**

Require coordination, source/Vitest/build, both Wrangler dry-runs, screenshots, and artifact all terminal SUCCESS.

- [ ] **Step 3: Revalidate and merge exact head**

Check current main drift for overlap, ensure PR is mergeable and exact head is unchanged, then merge with expected-head SHA only.

- [ ] **Step 4: Wait for production deploy stability**

Require on the merge SHA:

```text
GitHub verify = SUCCESS
Workers Builds: dubflow = SUCCESS
Workers Builds: dubflow-gateway = SUCCESS
```

Do not start the production fixture before these are terminal.

- [ ] **Step 5: Run the manual browser production fixture**

Dispatch `Production R2 Media Fixture` on the stable merge SHA and inspect terminal job logs. A PASS must include browser export launch, durable reload identity, completed per-language export, video/mp4 download, H.264, AAC, and packet-preservation checks.

- [ ] **Step 6: Update issue #91 truthfully**

Close #91 only if the real browser fixture is fully green. If any runtime step fails, keep #91 open, record the exact failing stage/code, and fix via a new RED→GREEN carrier without enabling paid resources.

- [ ] **Step 7: Keep #128 blocked pending signing-secret provenance**

Even after #91 media PASS, do not merge #128 until canonical `MEDIA_SOURCE_SIGNING_SECRET` use has separate sanitized live evidence.
