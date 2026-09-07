# Production Browser Piper Fixture Design

## Goal

Qualify issue #91 with one real production H.264 fixture that exercises the zero-cost Vietnamese browser-Piper lane end to end: R2 upload, production ASR/translation, browser-local Piper synthesis, exact-version client PCM upload, R2 dubbed export, and final H.264/AAC artifact verification.

## Constraints

- Production origin remains `https://yupvox.qs3d.site`.
- GitHub Actions is verification-only and must never deploy production.
- Cloudflare Workers Builds remains the only production deploy lane.
- No Cloudflare Stream, no Containers, no AI Gateway top-up, and no paid provider request.
- Vietnamese voice generation must come from the production browser Piper code path merged in #122.
- Do not add a public test-only route, debug endpoint, or production test hook.
- Keep #128 blocked after this fixture until canonical `MEDIA_SOURCE_SIGNING_SECRET` usage is independently verified live; an E2E media PASS alone does not prove which compatibility secret supplied signing authority.

## Selected Architecture

Use the existing deterministic Node production fixture orchestration for server-side setup/final verification, plus a real headless Chromium session controlled with pinned `playwright-core@1.63.0`. `playwright-core` is installed with `npm install --no-save` only inside the manual production-fixture workflow, so the application dependency graph and production bundle do not change.

The browser navigates to the real production project Studio at `/projects/:projectId` and uses the actual UI export action. The test does not import or duplicate Piper implementation code. Clicking `Export current language` invokes the deployed `StudioShell`, which performs exact-cache admission, creates `BrowserPiperClient` only when PCM is missing/stale, runs `TtsSession` in the deployed module Worker, uploads exact-version PCM, and launches the normal per-language dubbed export.

## Data Flow

1. Verify `/api/ready` is schema-14 R2/remux ready.
2. Generate a small deterministic H.264/AAC speech MP4 on the GitHub runner.
3. Create a fresh `en -> vi` project through the public production gateway.
4. Multipart-upload the fixture to production R2.
5. Start project processing and poll the durable job until it is exportable (`needs_review` or `completed`).
6. Fetch `/translations/vi` and require at least one completed Vietnamese translation with a positive version.
7. Launch real Chromium against `/projects/:projectId`.
8. Open the `Ngôn ngữ & export` Studio dock, wait for `Export current language` to be enabled, and click it.
9. Wait for the real production `POST /api/projects/:id/exports/vi` response. This request is allowed only after deployed Studio code has verified/uploaded exact-version client PCM.
10. Reload the production Studio and fetch the same latest export attempt from the page origin, proving a reload observes the durable export identity rather than transient client-only state.
11. Close the browser and poll `/exports/vi?output=dubbed` until `completed` or fail immediately on `failed`/`invalidated`.
12. Download `/exports/vi/media?output=dubbed` to the workflow output path.
13. Use `ffprobe` to require H.264 video and AAC audio, and compare extracted H.264 elementary-stream SHA-256 between input and output to prove packet preservation.

## Browser Driver

The fixture script resolves an already-installed Chrome/Chromium executable from `PRODUCTION_BROWSER_EXECUTABLE` or common runner paths. It launches Chromium headlessly through `playwright-core` with `--no-sandbox` only in the GitHub-hosted runner environment.

Browser assertions are intentionally based on stable production semantics:

- route: `/projects/:projectId`;
- Studio dock summary text: `Ngôn ngữ & export`;
- export control: `[data-testid="export-current-language"]`;
- launch network response: exact `POST /api/projects/:id/exports/vi`;
- durable reload proof: exact latest-export id returned by `/api/projects/:id/exports/vi?output=dubbed`.

The harness must not depend on screenshot pixel positions, private React state, Vite chunk names, or internal Piper module exports.

## Paid-Resource Safety

The server voice capability endpoint is not used as an admission gate for this fixture. That endpoint represents server providers and previously forced the paid/unconfigured TTS path. Vietnamese export admission is instead proven by the production Studio/browser client lane.

The workflow must not set any `PAID_*` flag, provider API key, AI Gateway credit setting, Stream binding, or Container resource. If production unexpectedly tries a paid TTS path, the fixture should fail rather than enabling it.

## Failure Semantics

- Readiness mismatch: fail before project creation.
- Process/ASR/translation failure: report durable job code/message and stop.
- Missing completed Vietnamese translation: fail before opening the browser.
- Browser Piper/model/Worker failure: surface browser console/page error plus the disabled/failed export state; do not fall back to server TTS.
- Client PCM upload/version mismatch: fail before accepting export launch.
- Export failure/invalidated state: report durable export code/message.
- Final codec or packet mismatch: fail qualification even if the API reported completion.

## Verification Strategy

### Source/TDD gate

Add a source contract test that initially fails until the manual workflow:

- installs pinned `playwright-core@1.63.0` without modifying production dependencies;
- invokes the browser fixture runner;
- keeps `workflow_dispatch` only;
- does not contain deploy, paid-provider, Stream, or Container commands.

The same test locks the browser runner to the production project route, real export control, per-language export endpoint, reload durability check, and output-file persistence.

### CI gate

Normal PR CI must remain FULL GREEN: source tests, all Vitest, production build, both Wrangler dry-runs, screenshots, and artifact.

### Runtime gate

After merge and successful backend/gateway Workers Builds on the exact merge SHA, manually run `Production R2 Media Fixture`. A PASS is accepted only when the browser-driven path finishes and ffprobe/packet-preservation checks pass.

## Runtime Status Rule

Issue #91 may be closed only after the real browser-driven production run passes every media acceptance gate. #128 must remain Draft after that until canonical `MEDIA_SOURCE_SIGNING_SECRET` usage is separately verified live without exposing secret material.
