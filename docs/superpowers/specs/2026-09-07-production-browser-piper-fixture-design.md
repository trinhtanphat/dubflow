# Production Browser Piper Fixture Design

## Goal

Qualify issue #91 with one real production H.264 fixture that exercises the zero-cost Vietnamese browser-Piper lane end to end: R2 upload, production ASR/translation, browser-local Piper synthesis, exact-version client PCM upload, R2 dubbed export, and final H.264/AAC artifact verification.

## Constraints

- Production origin remains `https://yupvox.qs3d.site`.
- GitHub Actions is verification-only and must never deploy production.
- Cloudflare Workers Builds remains the only production deploy lane.
- No Cloudflare Stream, no Containers, no AI Gateway top-up, and no paid provider request.
- Vietnamese voice generation must come from the production browser Piper code path merged in #122.
- Do not add a public test-only route, debug endpoint, production test hook, or application dependency just for qualification.
- `package.json` dependencies and devDependencies must remain unchanged; the carrier may only add the source-contract test to the existing `verify:deploy-config` script.
- Keep #128 blocked after this fixture until canonical `MEDIA_SOURCE_SIGNING_SECRET` usage is independently verified live; an E2E media PASS alone does not prove which compatibility secret supplied signing authority.

## Selected Architecture

Use the existing deterministic Node production fixture orchestration for server-side setup/final verification plus a real headless Chromium session controlled directly through the Chrome DevTools Protocol (CDP).

The runner uses only Node 22 built-ins and the Chrome/Chromium binary already present on the GitHub-hosted runner. It launches the browser with an isolated temporary user-data directory and `--remote-debugging-port=0`, captures the emitted DevTools WebSocket endpoint, and speaks CDP through Node's built-in `WebSocket`. No Playwright, Puppeteer, Selenium, browser extension, or new npm dependency is introduced.

The browser navigates to the real production project Studio at `/projects/:projectId` and uses the actual UI export action. The harness does not import or duplicate Piper implementation code. Triggering `Export current language` invokes the deployed `StudioShell`, which performs exact-cache admission, creates `BrowserPiperClient` only when PCM is missing/stale, runs the deployed Piper module Worker, uploads exact-version PCM, and launches the normal per-language dubbed export.

## Data Flow

1. Verify `/api/ready` is schema-14 R2/remux ready.
2. Generate a small deterministic H.264/AAC speech MP4 on the GitHub runner.
3. Create a fresh `en -> vi` project through the public production gateway.
4. Multipart-upload the fixture to production R2.
5. Start project processing and poll the durable job until it is exportable (`needs_review` or `completed`).
6. Fetch `/translations/vi` and require at least one completed Vietnamese translation with a positive version.
7. Launch real Chromium with CDP enabled and navigate to `/projects/:projectId`.
8. Through CDP `Runtime.evaluate`, open the `Ngôn ngữ & export` Studio dock using visible DOM semantics, then wait until `[data-testid="export-current-language"]` exists and is enabled.
9. Enable CDP `Network` events and trigger the real export button from the deployed page. Accept launch only after observing the exact production `POST /api/projects/:id/exports/vi` response.
10. The export request is considered browser-qualified only if the deployed Studio first verifies/uploads exact-version client PCM; server-side paid TTS capability is not used as admission for Vietnamese.
11. Reload the production Studio through CDP `Page.reload`, then query the latest `/api/projects/:id/exports/vi?output=dubbed` from the page origin and require the same export identity, proving durable state survives reload rather than existing only in transient React state.
12. Close Chromium and poll the same durable export through Node until `completed`, failing immediately on `failed` or `invalidated`.
13. Download `/api/projects/:id/exports/vi/media?output=dubbed` to the workflow output path.
14. Use `ffprobe` to require H.264 video and AAC audio, and compare extracted H.264 elementary-stream SHA-256 between input and output to prove packet preservation.

## CDP Driver

The fixture runner resolves `PRODUCTION_BROWSER_EXECUTABLE` first, then common GitHub-runner Chrome/Chromium paths. Chromium launches headless with `--no-sandbox` only in the GitHub-hosted runner environment and with a unique temporary profile.

The Node runner parses the browser's `DevTools listening on ws://...` stderr line, opens that WebSocket, and implements a small request/response dispatcher keyed by CDP command id. It creates/attaches to one page target and enables only the domains needed for qualification:

- `Page` for navigation and reload;
- `Runtime` for DOM-semantic checks/clicks and same-origin durable-state fetches;
- `Network` for observing the exact export launch request/response;
- `Log` only when available/useful for sanitized browser diagnostics.

Browser assertions are intentionally based on stable production semantics:

- route: `/projects/:projectId`;
- Studio dock visible text: `Ngôn ngữ & export`;
- export control: `[data-testid="export-current-language"]`;
- launch network response: exact `POST /api/projects/:id/exports/vi`;
- durable reload proof: exact latest-export id returned by `/api/projects/:id/exports/vi?output=dubbed`.

The harness must not depend on screenshot coordinates, private React state, Vite chunk names, Piper internal exports, or browser implementation-specific DOM node ids.

## Browser Interaction Semantics

CDP `Runtime.evaluate` is permitted only to operate the deployed page as a user-visible browser surface: find/open the export dock, inspect whether the export button is disabled, click the export button, and perform the post-reload same-origin fetch. It must not call internal application modules, mutate React state, forge client-voice cache records, or invoke export APIs directly before the UI action.

A JavaScript `.click()` on the real DOM button is acceptable because it follows the deployed React event handler and therefore exercises the same browser Piper/export control path without relying on pixel coordinates. The qualification contract remains the network evidence plus durable-state proof, not merely that a click function returned.

## Paid-Resource Safety

The server voice capability endpoint is not used as an admission gate for this fixture. That endpoint represents server providers and previously forced the paid/unconfigured TTS path. Vietnamese export admission is instead proven by the production Studio/browser client lane.

The workflow must not set any `PAID_*` flag, provider API key, AI Gateway credit setting, Stream binding, or Container resource. It must not install or invoke paid-provider SDKs. If production unexpectedly attempts a paid TTS path, the fixture must fail rather than enabling it.

The workflow remains `workflow_dispatch` only. Normal PR/main CI never runs the real production media fixture automatically.

A real production dispatch is additionally blocked by a **zero-charge runtime gate**. Before dispatching, current account/provider state for every request the fixture will make (including production ASR/translation) must be verified to remain inside a free allocation or other hard no-charge boundary. If the account can create billable overage, remaining free allowance cannot be verified, or the cost boundary is ambiguous, do not dispatch. Keep #91 OPEN/UNQUALIFIED and record `ZERO_CHARGE_RUNTIME_UNVERIFIED` instead. Source/CI qualification may proceed without that dispatch.

As defense in depth, the manual workflow exposes a required `zero_charge_verified` boolean input (default `false`) and passes it to the runner as `PRODUCTION_ZERO_CHARGE_VERIFIED`. The runner must reject anything other than the exact string `true` before `/api/ready` or any project creation request. This input is an execution guard, not a substitute for the external account/provider verification above.

## Failure Semantics

- Zero-charge acknowledgement missing: fail before readiness or project creation.
- Readiness mismatch: fail before project creation.
- Process/ASR/translation failure: report durable job code/message and stop.
- Missing completed Vietnamese translation: fail before opening the browser.
- Browser launch/CDP/WebSocket failure: fail with sanitized browser diagnostics.
- Browser Piper/model/Worker failure: surface page/console diagnostics plus the disabled/failed export state; do not fall back to server TTS.
- Export button never becomes enabled: fail and report the visible client-voice status/guard text.
- No matching `POST /exports/vi` network response after UI click: fail qualification.
- Client PCM upload/version mismatch: deployed Studio must refuse export; the fixture fails rather than bypassing the admission contract.
- Reload does not observe the same durable export identity: fail qualification.
- Export failure/invalidated state: report durable export code/message.
- Final codec or packet mismatch: fail qualification even if the API reported completion.

## Verification Strategy

### Source/TDD gate

Add a source contract test that initially fails until the manual workflow and browser runner prove all of the following:

- the workflow stays `workflow_dispatch` only;
- the workflow requires `zero_charge_verified` and forwards it as `PRODUCTION_ZERO_CHARGE_VERIFIED`;
- no Playwright/Puppeteer/Selenium dependency or install command is introduced;
- `package.json` dependency sections remain unchanged and only the verification script wiring is modified;
- the runner launches an existing Chrome/Chromium binary with CDP enabled;
- the runner rejects missing zero-charge acknowledgement before production requests;
- the runner uses the production project route and real export control;
- the runner observes the exact per-language export network response;
- the runner performs a reload durability check;
- the runner persists the final output file;
- no deploy, paid-provider, Stream, or Container command/config is added.

### CI gate

Normal PR CI must remain FULL GREEN: source tests, all Vitest, production build, both Wrangler dry-runs, screenshots, and artifact.

### Runtime gate

After merge and successful backend/gateway Workers Builds on the exact merge SHA, the real `Production R2 Media Fixture` remains manual. It may be dispatched only after the zero-charge runtime gate above is positively verified for that run. A PASS is accepted only when the CDP-driven production browser path finishes and ffprobe/packet-preservation checks pass.

## Runtime Status Rule

Issue #91 may be closed only after the real browser-driven production run passes every media acceptance gate under a positively verified zero-charge boundary. If zero-charge runtime status cannot be proved, #91 remains OPEN/UNQUALIFIED. #128 must remain Draft after any media PASS until canonical `MEDIA_SOURCE_SIGNING_SECRET` usage is separately verified live without exposing secret material.
