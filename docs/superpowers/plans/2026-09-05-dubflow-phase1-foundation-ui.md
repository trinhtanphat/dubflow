# DubFlow Phase 1 Foundation + Studio UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use TDD for behavior changes.

**Goal:** Build the Cloudflare Worker + React foundation and the complete Phase 1 dubbing studio UI, with D1/R2/Workers AI bindings prepared and Wrangler-only deployment.

**Architecture:** Vite builds the React/TypeScript frontend into `dist/`. A Hono Cloudflare Worker serves API routes and Workers Static Assets. D1 stores project metadata, R2 is reserved for media, Workers AI is bound for Phase 2, and the editor keeps timeline/data state separate from DOM rendering.

**Tech Stack:** React 19, TypeScript, Vite, Hono, Cloudflare Workers Static Assets, D1, R2, Workers AI, Wrangler, Vitest, Testing Library, Lucide React.

**Spec:** `docs/superpowers/specs/2026-09-05-dubflow-design.md`

## Global constraints

- Product name: DubFlow.
- Initial media target: 5 GB and 3 hours per source video.
- Primary target language: Vietnamese.
- Initial source languages: auto, Chinese, English, Japanese, Korean.
- No GitHub Actions; no `.github/workflows` directory.
- Deployment is manual/local via Wrangler.
- No secrets committed to Git.
- Worker must not buffer multi-GB media bodies in memory.
- Google translation must use the official Google Cloud Translation API.
- Voice cloning must never be claimed unless a configured provider explicitly supports it with consent/rights.

## File map

### Root
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.app.json`
- `tsconfig.worker.json`
- `vite.config.ts`
- `wrangler.jsonc`
- `index.html`
- `.gitignore`
- `README.md`
- `scripts/verify-no-github-actions.mjs`

### Worker
- `worker/src/index.ts`
- `worker/src/env.ts`
- `worker/src/domain/project.ts`
- `worker/src/db/projects.ts`
- `worker/src/routes/projects.ts`
- `worker/src/security/current-user.ts`
- `worker/src/http/json.ts`
- `worker/test/health.test.ts`
- `worker/test/projects.test.ts`
- `migrations/0001_initial.sql`

### Frontend
- `src/main.tsx`
- `src/app/App.tsx`
- `src/app/app.css`
- `src/app/mockProject.ts`
- `src/app/useStudioState.ts`
- `src/components/ui/IconButton.tsx`
- `src/components/ui/Panel.tsx`
- `src/features/upload/mediaValidation.ts`
- `src/features/upload/UploadPanel.tsx`
- `src/features/player/time.ts`
- `src/features/player/VideoStage.tsx`
- `src/features/speakers/SpeakerList.tsx`
- `src/features/transcript/ScriptInspector.tsx`
- `src/features/timeline/types.ts`
- `src/features/timeline/math.ts`
- `src/features/timeline/Timeline.tsx`
- `src/features/timeline/TimelineTrack.tsx`
- `src/features/timeline/SegmentBlock.tsx`
- `src/features/timeline/WaveformTrack.tsx`
- `src/lib/api/client.ts`
- `src/features/projects/projectApi.ts`
- `src/features/projects/useProject.ts`

## Task 1 — Bootstrap Worker + React

- [ ] Write `worker/test/health.test.ts` first for `GET /api/health` returning `{ ok:true, service:"dubflow", phase:"foundation" }`.
- [ ] Run the focused test and confirm RED because Worker code does not exist.
- [ ] Add package/config files, Vite React bootstrap, Cloudflare binding types, Hono Worker and `/api/health`.
- [ ] Configure Workers Static Assets with `dist`, D1 binding `DB`, R2 binding `MEDIA`, Workers AI binding `AI`.
- [ ] Run focused test, typecheck and build; require GREEN before commit.
- [ ] Commit: `chore: bootstrap DubFlow worker and React app`.

## Task 2 — D1 project foundation

- [ ] Write project API tests first: create/list/get project, Vietnamese target, reject unsupported source language.
- [ ] Confirm RED.
- [ ] Add D1 migration for users, projects, speakers, segments, jobs and usage events.
- [ ] Add `ProjectRepository` with `create`, `listByUser`, `getByIdForUser`.
- [ ] Use development identity only through `getCurrentUserId()` returning `dev-user` so real auth can replace one boundary later.
- [ ] Run focused tests + typecheck GREEN.
- [ ] Commit: `feat: add D1 project foundation`.

## Task 3 — Studio shell

- [ ] Write App render/accessibility test first for DubFlow banner, main workspace, upload, characters, script and Vietnamese target labels.
- [ ] Confirm RED.
- [ ] Build dark workstation UI with purple accent without copying YupVox branding.
- [ ] Desktop layout: 280px left rail, flexible center, 300px right inspector; responsive stack under 1100px.
- [ ] Add top bar with project name, cloud badge, credits placeholder and export button.
- [ ] Add pure/reducer-based studio state for selected segment, playhead, languages and lip-sync toggle.
- [ ] Run App test + build GREEN.
- [ ] Commit: `feat: add DubFlow studio shell`.

## Task 4 — Media selection

- [ ] Write validation tests first for accepted MP4/WebM/MKV/MOV, 5 GB max, 3 hour max.
- [ ] Confirm RED.
- [ ] Implement pure `validateMediaFile` and `validateMediaDuration`.
- [ ] Build drag/drop + click file picker, selected file metadata and inline errors.
- [ ] Phase 1 must not upload full media through the Worker.
- [ ] Run focused test + build GREEN.
- [ ] Commit: `feat: add validated media selection`.

## Task 5 — Video stage

- [ ] Write `formatTimestamp` tests first for 00:00, 15:23 and 1:02:03.
- [ ] Confirm RED.
- [ ] Build local object-URL video preview with cleanup.
- [ ] Add play/pause, previous/next segment, mute, speed indicator, fit/fullscreen affordances.
- [ ] Render source subtitle plus Vietnamese subtitle and current/duration time.
- [ ] Run focused tests + build GREEN.
- [ ] Commit: `feat: add video stage and subtitle overlay`.

## Task 6 — Speakers + script inspector

- [ ] Extend App test first to select a segment and edit Vietnamese text.
- [ ] Confirm RED.
- [ ] Add deterministic mock speakers/segments for Phase 1 visual/editor behavior.
- [ ] Add immutable actions for select segment, edit source, edit translation, assign speaker and toggle lip-sync.
- [ ] Add character cards with deterministic waveform sparkline and duration share.
- [ ] Show voice preview/regenerate controls as `Phase 2` unavailable states; never fake AI success.
- [ ] Run App test + build GREEN.
- [ ] Commit: `feat: add editable transcript and speaker controls`.

## Task 7 — Multi-track timeline

- [ ] Write timeline math tests first for time→percent and clamping.
- [ ] Confirm RED.
- [ ] Render ruler, video strip, source subtitles, Vietnamese subtitles, and one waveform row per speaker.
- [ ] Keep positioning math in pure functions; render `SegmentBlock` with absolute percentage geometry.
- [ ] Render one playhead line and selectable segment state.
- [ ] Generate deterministic waveform values; do not call `Math.random()` during render.
- [ ] Run focused tests + full build GREEN.
- [ ] Commit: `feat: add multi-track studio timeline`.

## Task 8 — Project API client

- [ ] Write frontend + Worker persistence tests first.
- [ ] Confirm RED.
- [ ] Add typed `apiFetch<T>` and `ApiError(status, code, message)`.
- [ ] Add project create/list client and `useProject` loader.
- [ ] Empty local project lists may show deterministic demo content; network/API failures must display an error banner rather than masquerading as success.
- [ ] Run all tests + build GREEN.
- [ ] Commit: `feat: connect studio to project API`.

## Task 9 — Wrangler-only delivery guard

- [ ] Add `scripts/verify-no-github-actions.mjs` that exits 1 if `.github/workflows` exists.
- [ ] Add `npm run verify:no-actions` and `npm run verify`.
- [ ] README commands: `npm install`, `npx wrangler login`, `npx wrangler d1 create dubflow-db`, `npx wrangler r2 bucket create dubflow-media`, update D1 ID, apply migrations, `npm run verify`, `npx wrangler deploy`.
- [ ] Document future `npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY` without storing a value.
- [ ] Run `npm run verify` GREEN.
- [ ] Commit: `docs: add Wrangler-only deployment workflow`.

## Phase 1 completion gate

Phase 1 is complete only when:

- `npm run verify` exits 0 locally.
- No GitHub Actions workflows exist.
- React `dist/` builds successfully.
- Worker health and project route tests pass.
- Upload validation enforces 5 GB and 3 hours.
- UI contains upload, player, dual subtitles, speaker list, script inspector and multi-track timeline.
- Phase 2-only AI buttons are explicitly unavailable rather than simulated.
- README contains D1/R2/Wrangler setup and deploy instructions.

## Follow-on plans

After Phase 1, create separate implementation plans for:

1. Phase 2 — R2 multipart upload, FFmpeg container, Workers AI ASR, Workers AI + Google Cloud Translation router, persisted editable segments, TTS, duration fitting and export.
2. Phase 3 — Cloudflare Workflows, SSE job progress, credits ledger, retry/cancel, production auth boundary, observability and rate limits.
3. Phase 4 — stronger diarization, optional consent-aware voice cloning provider, dialogue/background separation, optional visual lip-sync, glossary/style presets and multi-language batch export.
