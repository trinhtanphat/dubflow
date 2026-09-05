# YupVox Studio Pro V2.2 Player + Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the faux video stage with secure playback of the uploaded R2 source and add synchronized seek/zoom/scroll/playhead behavior to the existing timeline without changing subtitle timing semantics yet.

**Architecture:** Keep the source object private in R2 and expose it through an ownership-checked same-origin Worker media route with HTTP byte-range support. Frontend playback is split between serializable reducer state and a focused `VideoStage` that owns the `<video>` element; timeline view math remains pure/tested, while high-frequency media time events dispatch only the playhead update needed by the editor. Segment move/resize/split remains V2.3.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Vitest 3, Hono, Cloudflare Workers Static Assets, Cloudflare R2, D1.

**Spec:** `docs/superpowers/specs/2026-09-05-yupvox-studio-pro-v2-design.md`

## Global Constraints

- Production target remains `https://yupvox.qs3d.site`.
- Existing media target remains 5 GB / 3 hours.
- Uploaded media stays private in R2; never make the source bucket public.
- Media access must be ownership-checked through the existing current-user boundary.
- A video placeholder must be explicitly empty/processing when no playable media exists; it must not pretend to be uploaded footage.
- Playback time is transient state and must not enter undo history.
- V2.2 does not implement segment move, edge-resize, split, persistence revisions, voice generation, visual lip-sync, or fake export.
- Timeline math is pure and unit-tested.
- Every new behavior follows RED → GREEN TDD.
- GitHub Actions CI remains the authoritative dependency/test/typecheck/Vite/Wrangler dry-run gate.
- Production deployment remains the existing Cloudflare workflow from `main`.

---

### Task 1: Private R2 media streaming with HTTP Range support

**Files:**
- Modify: `worker/src/cloudflare/r2.ts`
- Create: `worker/src/services/media.ts`
- Create: `worker/test/media.test.ts`
- Create: `worker/src/routes/media.ts`
- Create: `worker/test/media-route.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Extend `R2BucketLike` with:

```ts
export type R2Range = { offset: number; length: number };
export type R2GetOptions = { range?: R2Range };
export type R2ObjectBodyLike = {
  key: string;
  size: number;
  body: ReadableStream;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
  range?: { offset: number; length: number };
};

get(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null>;
```

- Produce:

```ts
export type ParsedByteRange = { offset: number; length: number; end: number };
export function parseByteRange(header: string | null, size: number): ParsedByteRange | null;
export function createMediaRoutes(): Hono<{ Bindings: Env }>;
```

- Route contract: `GET /api/projects/:id/media`.

- [ ] **Step 1: Write failing byte-range tests**

Create `worker/test/media.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/services/media';

describe('parseByteRange', () => {
  it('parses an inclusive HTTP byte range', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ offset: 100, length: 100, end: 199 });
  });

  it('supports open-ended ranges and rejects invalid ranges', () => {
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ offset: 900, length: 100, end: 999 });
    expect(parseByteRange('bytes=1000-1001', 1000)).toBeNull();
    expect(parseByteRange('items=0-10', 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npx vitest run worker/test/media.test.ts
```

Expected: FAIL because `worker/src/services/media.ts` does not exist.

- [ ] **Step 3: Implement the minimal range parser**

Create `worker/src/services/media.ts`:

```ts
export type ParsedByteRange = { offset: number; length: number; end: number };

export function parseByteRange(header: string | null, size: number): ParsedByteRange | null {
  if (!header || !Number.isFinite(size) || size <= 0) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= size || requestedEnd < offset) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, end, length: end - offset + 1 };
}
```

Run the focused test again. Expected: PASS.

- [ ] **Step 4: Write the failing owned-media route tests**

Create `worker/test/media-route.test.ts` with in-memory project and bucket implementations. Test all four externally visible behaviors:

```ts
it('returns 404 when the project is not owned by the current user');
it('returns 409 when the owned project has no source object yet');
it('returns 200 with Accept-Ranges for a full object request');
it('returns 206 with Content-Range for bytes=2-4');
```

For the 206 assertion use a six-byte object and require:

```ts
expect(response.status).toBe(206);
expect(response.headers.get('accept-ranges')).toBe('bytes');
expect(response.headers.get('content-range')).toBe('bytes 2-4/6');
expect(response.headers.get('content-length')).toBe('3');
expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]));
```

- [ ] **Step 5: Run route tests and confirm RED**

```bash
npx vitest run worker/test/media-route.test.ts
```

Expected: FAIL because `createMediaRoutes` and R2 `get()` support are absent.

- [ ] **Step 6: Extend the R2 boundary and implement the route**

`worker/src/routes/media.ts` must:

1. Load the project with `ProjectRepository.getByIdForUser(id, getCurrentUserId())`.
2. Return `404 PROJECT_NOT_FOUND` for non-owned/missing projects.
3. Return `409 MEDIA_NOT_READY` when `sourceObjectKey` is absent.
4. Use `project.sizeBytes` to validate the incoming `Range` header before calling R2.
5. Call `MEDIA.get(key)` for a full request and `MEDIA.get(key, { range: { offset, length } })` for a partial request.
6. Return `404 MEDIA_OBJECT_NOT_FOUND` if R2 has no object.
7. Return `Accept-Ranges: bytes`, `Content-Type` from R2 metadata or `application/octet-stream`, and `ETag` when available.
8. Return `206` plus `Content-Range`/range `Content-Length` for a valid byte range; return `200` plus full `Content-Length` otherwise.
9. Return `416` with `Content-Range: bytes */<size>` when a syntactically present `Range` header cannot be satisfied.

Register the route before the asset fallback:

```ts
app.route('/api/projects', createMediaRoutes());
```

- [ ] **Step 7: Run media tests and full Worker tests**

```bash
npx vitest run worker/test/media.test.ts worker/test/media-route.test.ts worker/test/uploads.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add worker/src/cloudflare/r2.ts worker/src/services/media.ts worker/src/routes/media.ts worker/src/index.ts worker/test/media.test.ts worker/test/media-route.test.ts
git commit -m "feat(media): stream private R2 source with byte ranges"
```

---

### Task 2: Playback state and project media URL contract

**Files:**
- Modify: `src/features/timeline/types.ts`
- Modify: `src/app/studioState.ts`
- Modify: `src/app/studioState.test.ts`
- Create: `src/features/player/playback.ts`
- Create: `src/features/player/playback.test.ts`

**Interfaces:**
- Extend `StudioProject` with optional source readiness fields:

```ts
sourceObjectKey?: string | null;
status?: string;
frameRate?: number | null;
```

- Extend `StudioState`:

```ts
playback: {
  playing: boolean;
  rate: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;
  volume: number;
  muted: boolean;
};
```

- Add transient actions:

```ts
| { type: 'setPlaying'; playing: boolean }
| { type: 'setPlaybackRate'; rate: StudioState['playback']['rate'] }
| { type: 'setVolume'; volume: number }
| { type: 'toggleMuted' }
```

- Produce helpers:

```ts
export function mediaUrlForProject(project: Pick<StudioProject, 'id' | 'sourceObjectKey'>): string | null;
export function frameStepMs(frameRate?: number | null): number;
```

- [ ] **Step 1: Write failing playback helper tests**

`playback.test.ts`:

```ts
expect(mediaUrlForProject({ id: 'p1', sourceObjectKey: 'projects/p1/source/a.mp4' })).toBe('/api/projects/p1/media');
expect(mediaUrlForProject({ id: 'p1', sourceObjectKey: null })).toBeNull();
expect(frameStepMs(25)).toBe(40);
expect(frameStepMs(null)).toBeCloseTo(1000 / 30);
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/features/player/playback.test.ts
```

Expected: FAIL because `playback.ts` does not exist.

- [ ] **Step 3: Implement minimal helpers**

`mediaUrlForProject` returns the same-origin API route only when `sourceObjectKey` exists. `frameStepMs` uses the supplied positive finite FPS, otherwise 30 FPS.

- [ ] **Step 4: Add failing reducer tests for transient playback state**

Extend `studioState.test.ts` to require:

```ts
expect(initial.playback).toEqual({ playing: false, rate: 1, volume: 1, muted: false });
expect(studioReducer(initial, { type: 'setPlaying', playing: true }).playback.playing).toBe(true);
expect(studioReducer(initial, { type: 'setPlaybackRate', rate: 1.5 }).playback.rate).toBe(1.5);
expect(studioReducer(initial, { type: 'setVolume', volume: 2 }).playback.volume).toBe(1);
expect(studioReducer(initial, { type: 'setVolume', volume: -1 }).playback.volume).toBe(0);
```

- [ ] **Step 5: Run reducer test and confirm RED**

```bash
npx vitest run src/app/studioState.test.ts
```

Expected: FAIL because `playback` and actions are absent.

- [ ] **Step 6: Implement minimal playback reducer state**

Initialize playback to `{ playing: false, rate: 1, volume: 1, muted: false }`; clamp volume to `[0,1]`; playback actions must not touch project data or selected segment.

- [ ] **Step 7: Run focused tests and commit**

```bash
npx vitest run src/features/player/playback.test.ts src/app/studioState.test.ts
git add src/features/player src/features/timeline/types.ts src/app/studioState.ts src/app/studioState.test.ts
git commit -m "feat(player): add transient playback state"
```

---

### Task 3: Real HTML video surface and truthful player states

**Files:**
- Create: `src/features/player/VideoStage.test.tsx`
- Modify: `src/features/player/VideoStage.tsx`
- Create: `src/features/player/player.css`
- Modify: `src/main.tsx`
- Modify: `src/app/StudioShell.tsx`

**Interfaces:**
- `VideoStage` consumes:

```ts
{
  project: StudioProject;
  segment?: Segment;
  playheadMs: number;
  playback: StudioState['playback'];
  dispatch: Dispatch<StudioAction>;
}
```

- DOM contract:
  - ready source: `<video class="studio-video" src="/api/projects/<id>/media" preload="metadata" playsInline>`.
  - absent source: `.video-empty-state` with `Chưa có media phát được`.
  - project `processing`: `.video-processing-state` with `Media đang được xử lý`.
  - subtitle overlay remains above the real video.

- [ ] **Step 1: Write failing render-state tests**

Create `VideoStage.test.tsx` using `renderToStaticMarkup` and require:

```ts
expect(readyHtml).toContain('<video');
expect(readyHtml).toContain('src="/api/projects/p1/media"');
expect(emptyHtml).toContain('Chưa có media phát được');
expect(processingHtml).toContain('Media đang được xử lý');
expect(readyHtml).toContain('Lời gốc');
expect(readyHtml).toContain('Bản dịch');
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/features/player/VideoStage.test.tsx
```

Expected: FAIL because the current component only renders faux artwork and its prop contract lacks `project/playback/dispatch`.

- [ ] **Step 3: Replace faux footage with the truthful media state machine**

Use `mediaUrlForProject(project)` to decide ready vs empty. If `project.status === 'processing'` and no URL exists, show processing instead of empty.

Keep transport controls and subtitle overlay. Remove faux moon/pagoda/character elements from the ready path; they may remain only as neutral visual decoration inside the explicit empty state.

- [ ] **Step 4: Wire `<video>` events and commands**

Use a `videoRef` and implement:

```ts
const seekToMs = (ms: number) => {
  if (videoRef.current) videoRef.current.currentTime = Math.max(0, ms) / 1000;
  dispatch({ type: 'setPlayhead', playheadMs: ms });
};
```

Required event behavior:
- `onTimeUpdate`: dispatch currentTime in ms.
- `onPlay/onPause`: update `setPlaying`.
- reducer `rate` drives `video.playbackRate`.
- reducer `volume` drives `video.volume`.
- reducer `muted` drives `video.muted`.
- play button calls `video.play()` or `video.pause()`.
- skip back/forward seeks by 5000 ms.
- frame-step seeks by `frameStepMs(project.frameRate)` and pauses first.
- rate button cycles `0.5 → 0.75 → 1 → 1.25 → 1.5 → 2 → 0.5`.
- volume button toggles muted.
- fullscreen calls `video.requestFullscreen()` when available.

Do not dispatch project mutations for any playback event.

- [ ] **Step 5: Add player styling and run tests/build**

Import `player.css` from `src/main.tsx`. The video must use `object-fit: contain`, center on a black stage, and leave subtitle/transport layers readable.

Run:

```bash
npx vitest run src/features/player/VideoStage.test.tsx src/app/App.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/player src/app/StudioShell.tsx src/main.tsx
git commit -m "feat(player): render and control real source video"
```

---

### Task 4: Pure timeline zoom/scroll/seek math and view state

**Files:**
- Modify: `src/features/timeline/math.ts`
- Modify: `src/features/timeline/math.test.ts`
- Modify: `src/app/studioState.ts`
- Modify: `src/app/studioState.test.ts`

**Interfaces:**
- Extend `StudioState`:

```ts
timelineView: {
  pixelsPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
};
```

- Add actions:

```ts
| { type: 'setTimelineZoom'; pixelsPerSecond: number }
| { type: 'setTimelineScroll'; scrollLeft: number }
| { type: 'setTimelineViewport'; viewportWidth: number }
```

- Produce pure helpers:

```ts
export const MIN_PIXELS_PER_SECOND = 0.25;
export const MAX_PIXELS_PER_SECOND = 240;
export function clampPixelsPerSecond(value: number): number;
export function timeToPixels(timeMs: number, pixelsPerSecond: number): number;
export function pixelsToTime(px: number, pixelsPerSecond: number): number;
export function projectWidthPx(durationMs: number, pixelsPerSecond: number): number;
export function fitPixelsPerSecond(durationMs: number, viewportWidth: number): number;
```

- [ ] **Step 1: Write failing timeline math tests**

Add cases:

```ts
expect(timeToPixels(2000, 50)).toBe(100);
expect(pixelsToTime(125, 50)).toBe(2500);
expect(clampPixelsPerSecond(0)).toBe(MIN_PIXELS_PER_SECOND);
expect(clampPixelsPerSecond(1000)).toBe(MAX_PIXELS_PER_SECOND);
expect(projectWidthPx(10_000, 50)).toBe(500);
expect(fitPixelsPerSecond(10_000, 500)).toBe(50);
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/features/timeline/math.test.ts
```

Expected: FAIL because new helpers are absent.

- [ ] **Step 3: Implement minimal pure math**

All helpers must handle non-finite/zero inputs safely and use `clampPixelsPerSecond` for zoom output.

- [ ] **Step 4: Write failing reducer view-state tests**

Require default `pixelsPerSecond` to be `1`, scroll/viewport non-negative, and zoom clamped through the pure helper.

- [ ] **Step 5: Run RED, implement reducer state, rerun GREEN**

```bash
npx vitest run src/features/timeline/math.test.ts src/app/studioState.test.ts
```

Expected after implementation: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/features/timeline/math.ts src/features/timeline/math.test.ts src/app/studioState.ts src/app/studioState.test.ts
git commit -m "feat(timeline): add tested zoom and viewport state"
```

---

### Task 5: Interactive timeline toolbar, horizontal viewport and draggable playhead

**Files:**
- Create: `src/features/timeline/Timeline.test.tsx`
- Modify: `src/features/timeline/Timeline.tsx`
- Modify: `src/features/timeline/TimelineTrack.tsx`
- Modify: `src/features/timeline/SegmentBlock.tsx`
- Modify: `src/features/timeline/WaveformTrack.tsx`
- Create: `src/features/timeline/timeline.css`
- Modify: `src/main.tsx`

**Interfaces:**
- `Timeline` additionally consumes `timelineView: StudioState['timelineView']`.
- Timeline toolbar controls:
  - `aria-label="Thu nhỏ timeline"`
  - `aria-label="Phóng to timeline"`
  - `aria-label="Vừa toàn dự án"`
- Timeline interactive content uses one horizontally scrollable viewport and a project canvas width from `projectWidthPx`.

- [ ] **Step 1: Write failing render contract test**

`Timeline.test.tsx` must render a project and require the three toolbar labels plus a `data-timeline-canvas` element whose inline width reflects `projectWidthPx`.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/features/timeline/Timeline.test.tsx
```

Expected: FAIL because the toolbar/canvas contract is absent.

- [ ] **Step 3: Implement toolbar and project-width canvas**

Replace percentage-only placement with pixel placement inside the project canvas:

```ts
left: timeToPixels(segment.startMs, pixelsPerSecond)
width: Math.max(2, timeToPixels(segment.endMs - segment.startMs, pixelsPerSecond))
```

The existing labels stay in a fixed column; ruler/content scroll horizontally together.

Zoom buttons multiply/divide by `1.25`. Fit uses `fitPixelsPerSecond(project.durationMs, timelineView.viewportWidth)`.

- [ ] **Step 4: Write failing seek/playhead interaction tests against pure coordinate conversion**

Add a pure helper in `math.ts` if needed:

```ts
export function pointerXToTime(pointerClientX: number, viewportLeft: number, scrollLeft: number, pixelsPerSecond: number): number;
```

Test:

```ts
expect(pointerXToTime(250, 100, 50, 50)).toBe(4000);
```

Run RED before implementation, then GREEN.

- [ ] **Step 5: Wire direct seek and playhead drag**

On timeline canvas pointer down outside an interactive segment:

```ts
dispatch({ type: 'setPlayhead', playheadMs: clamp(targetMs, 0, project.durationMs) });
```

The playhead itself uses pointer capture on drag and repeatedly dispatches transient `setPlayhead` actions. `Escape`/pointer cancel ends the drag without changing project data.

- [ ] **Step 6: Wire scroll and viewport measurement**

- `onScroll` dispatches `setTimelineScroll`.
- `ResizeObserver` updates `setTimelineViewport` when available.
- Server/test render must not require `ResizeObserver`.
- Keep timeline horizontally scrollable below 900 px.

- [ ] **Step 7: Add visible-tick ruler generation**

Do not keep the hard-coded `[0,10,20,30,40,45]` ruler. Generate major marks from duration and zoom, with a bounded count. For V2.2 choose the interval from `[1, 2, 5, 10, 30, 60, 300, 600]` seconds such that adjacent labels are approximately at least 80 px apart.

Add a pure `chooseRulerIntervalSeconds(pixelsPerSecond)` test before implementation.

- [ ] **Step 8: Run timeline tests/build and commit**

```bash
npx vitest run src/features/timeline/math.test.ts src/features/timeline/Timeline.test.tsx src/app/studioState.test.ts
npm run build
git add src/features/timeline src/main.tsx
git commit -m "feat(timeline): add synchronized zoom seek and playhead"
```

---

### Task 6: Player ↔ timeline synchronization integration and V2.2 gate

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/features/player/VideoStage.tsx`
- Modify: `src/features/timeline/Timeline.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `README.md` only if the current README documents faux-player behavior.

**Interfaces:**
- Single source of truth for editor playhead remains `state.playheadMs`.
- Video `timeupdate` writes playhead.
- Timeline seek/drag writes playhead and `VideoStage` must apply external playhead changes to the video element when drift exceeds 100 ms.

- [ ] **Step 1: Write failing shell-level integration assertions**

Extend the app test to require:

```ts
expect(html).toContain('aria-label="Video source"');
expect(html).toContain('aria-label="Phóng to timeline"');
expect(html).toContain('aria-label="Vừa toàn dự án"');
```

The mock project remains without a real source object, so the shell must also contain `Chưa có media phát được` instead of faux footage.

- [ ] **Step 2: Run and confirm RED if any shell contract is missing**

```bash
npx vitest run src/app/App.test.tsx
```

- [ ] **Step 3: Implement external playhead reconciliation**

Inside `VideoStage`, after receiving a new `playheadMs`, synchronize the element only when:

```ts
Math.abs(video.currentTime * 1000 - playheadMs) > 100
```

This prevents feedback loops from normal `timeupdate` jitter.

- [ ] **Step 4: Run the complete verification suite**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: deploy-config Node tests, Vitest, TypeScript/Vite build and Wrangler dry-run all PASS with zero test failures.

- [ ] **Step 5: Review the complete PR diff**

Review for:
- no public R2 bucket exposure
- ownership check before R2 read
- valid 200/206/416 range semantics
- no faux uploaded video claim
- no playback action added to undoable/durable state
- no V2.3 segment mutation accidentally introduced
- accessible labels for icon-only/player/timeline controls
- no unbounded ruler DOM generation

Fix any Important/Critical finding with a new failing regression test first.

- [ ] **Step 6: Final exact-head CI gate and merge**

Push/open PR against `main`; require fresh exact-head GitHub Actions GREEN. Re-read `main` and PR head immediately before merge. Merge only when current `main` is the expected base and the PR is mergeable.

- [ ] **Step 7: Verify post-merge production**

After merge require:
- `main` CI GREEN
- `Deploy Cloudflare` GREEN
- production readiness step GREEN on `https://yupvox.qs3d.site`

Only after these gates is V2.2 considered landed; then start the separate V2.3 segment-editing plan.
