# YupVox Studio Pro V2 — Design Spec

Date: 2026-09-05
Status: Approved design, implementation pending
Repository: `trinhtanphat/dubflow`
Production target: `https://yupvox.qs3d.site`

## 1. Goal

Upgrade YupVox from a strong visual demo shell into a production-grade AI dubbing workstation with a polished editor experience, richer interaction, durable project state, transparent cloud processing, and an interface that stays fast and understandable during long-form dubbing work.

The V2 goal is not to imitate a full nonlinear video editor. It is to deliver the highest-value dubbing interactions: accurate media navigation, subtitle timing edits, speaker/voice assignment, translation comparison, cloud job visibility, undo/redo, autosave, and a timeline that feels responsive and trustworthy.

## 2. Product principles

1. **Studio-first UX.** The editor should feel like a dedicated creative tool, not a generic dashboard.
2. **Truthful capability states.** Features that are unavailable in the active provider stack must show an explicit unavailable/degraded state instead of pretending to succeed.
3. **Direct manipulation.** Timing, selection, playhead, segment splitting and lane interactions should happen in-place on the timeline.
4. **Progressive complexity.** The default view stays clean; advanced controls appear in the inspector, menus, shortcuts and command palette.
5. **Cloud-native durability.** User edits and job state persist independently of the current browser session.
6. **No silent data loss.** Autosave, retry and dirty-state indicators must be visible and testable.
7. **Long-form performance.** The UI must remain usable for videos up to the existing product target of 5 GB / 3 hours.

## 3. Scope

### 3.1 Included in Studio Pro V2

- Premium dark studio visual system and layout refinement.
- Real HTML video playback surface with source media URL support.
- Play/pause, seek, frame-step controls, playback rate and volume.
- Dual subtitle overlay with source and target text.
- Interactive timeline with zoom, horizontal scroll, draggable playhead and snapping.
- Subtitle segment selection, split, move and edge-resize timing edits.
- Source subtitle, translated subtitle and per-speaker audio lanes.
- Lightweight waveform visualization with deterministic placeholders until generated waveform data exists.
- Inspector tabs for Script, Characters, Voice and AI.
- Translation provider mode selection: Workers AI, Google, compare.
- Per-segment regenerate translation action and status.
- Per-segment speaker/voice assignment.
- Voice preview and regenerate controls wired to capability state; unavailable providers remain visibly disabled with explanation.
- Lip-sync control with capability-aware state.
- Undo/redo for local editor mutations.
- Keyboard shortcuts for core editing actions.
- Command palette for common editor actions.
- Autosave and durable project/segment timing persistence.
- Toasts, loading states, skeletons, retry states and clear error messages.
- Cloud job status presentation.
- Responsive desktop-first behavior with a compact mode for smaller widths.
- Accessibility improvements: keyboard focus, labels, reduced-motion support and contrast-safe states.
- Regression tests for editor state, timing math, command behavior and critical UI states.
- GitHub Actions CI remains the authoritative source/build gate.
- Production deployment remains through Cloudflare Workers + Static Assets to `yupvox.qs3d.site`.

### 3.2 Explicitly not part of this V2 implementation

- Full Premiere/DaVinci-grade video editing.
- Arbitrary video effects, transitions or color grading.
- Multicam editing.
- Production-quality visual lip-sync unless a verified provider is added.
- Voice cloning claims without a provider that explicitly supports it and appropriate user rights/consent.
- Fake final export when the FFmpeg media processor is unavailable.

## 4. Information architecture

The workspace remains three-column, but the proportions and responsibilities are tightened.

### Top bar

Contains:
- YupVox identity.
- Editable project title.
- Autosave status: `Saving…`, `Saved`, `Offline`, `Retrying`.
- Cloud processing status.
- Undo / redo.
- Command palette trigger.
- Export action with truthful capability state.

### Left rail

Contains:
- Source media card and upload/progress state.
- Media metadata: duration, size, resolution when available.
- Source and target language controls.
- Dubbing action/status.
- Character/speaker detection list.
- Search/filter for speakers when the project has many voices.

### Center stage

Contains:
- Real video player.
- Subtitle overlay.
- Playback controls.
- Timeline toolbar.
- Interactive timeline.

### Right inspector

Contains four tabs:
- **Script:** source text, translation, timing, per-segment actions.
- **Characters:** speaker identity, color, occurrence count, assignment.
- **Voice:** active provider capability, voice selection, preview/regenerate state.
- **AI:** translation provider, compare mode, processing/retry status and model metadata.

## 5. Visual system

### 5.1 Design tokens

Replace the monolithic stylesheet with a small token layer and feature-scoped styles.

Token groups:
- background surfaces
- text hierarchy
- border hierarchy
- semantic colors
- speaker lane colors
- spacing scale
- radius scale
- elevation/shadow scale
- focus ring
- motion durations

The visual character stays dark, cinematic and purple-accented, but V2 reduces decorative gradients where they compete with content. Primary actions use the purple accent; destructive/error actions use semantic red; cloud-ready states use green only when the state is actually healthy.

### 5.2 Density

The studio uses compact professional spacing. Large empty dashboard spacing is avoided. Text sizes are tuned for continuous editing, with stronger hierarchy around active segment, current time and job status.

### 5.3 Responsive behavior

Desktop >= 1280px:
- full three-column layout.

Medium 900–1279px:
- narrower left rail and inspector.
- inspector can collapse.

Small < 900px:
- center stage remains primary.
- side panels become drawers/tabs.
- timeline remains horizontally scrollable.

## 6. Frontend architecture

### 6.1 App shell

`src/app/App.tsx` becomes composition-only. Feature behavior moves into dedicated modules.

Proposed structure:

```text
src/
  app/
    App.tsx
    StudioShell.tsx
    studioState.ts
    useStudioState.ts
    useAutosave.ts
    shortcuts.ts
  components/
    Button/
    IconButton/
    Tooltip/
    Toast/
    Skeleton/
    CommandPalette/
    StatusBadge/
  features/
    player/
    timeline/
    transcript/
    speakers/
    voice/
    ai/
    upload/
    jobs/
  styles/
    tokens.css
    globals.css
    layout.css
```

Feature modules own their behavior and CSS. The app shell should not contain feature logic.

### 6.2 State model

The existing reducer pattern remains, expanded into explicit editor domains:

```text
StudioState
  project
  selection
  playback
  timelineView
  inspector
  history
  persistence
  cloudJobs
  capabilities
```

Key rules:
- reducer actions are serializable.
- undoable mutations are separated from transient UI actions.
- playback time changes are not pushed into undo history.
- autosave operates on durable project mutations only.
- cloud job state is not part of local undo history.

### 6.3 Undo/redo

Use bounded in-memory history for editor mutations:
- text edits
- speaker assignment
- segment timing
- split
- translated text replacement

History size defaults to 100 operations.

Undo/redo should preserve active selection when possible.

## 7. Video player

The faux artwork is replaced by a real `<video>` surface once a source object/playback URL exists.

Capabilities:
- play/pause
- precise seek
- skip +/- 5 seconds
- frame-step approximation based on project frame rate when metadata exists
- playback rates: 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x
- mute and volume
- fullscreen
- subtitle overlay
- current-time sync to timeline playhead

When media is not yet available, the existing cinematic placeholder style becomes a clear empty/processing state rather than pretending to be the uploaded video.

## 8. Timeline design

### 8.1 View model

Timeline state stores:
- pixels per second
- scrollLeft
- viewport width
- current playhead
- snap mode
- active drag operation

All timing math is kept in pure utility functions and tested independently.

### 8.2 Zoom

Zoom range:
- overview mode sufficient to see the full project
- detailed mode sufficient to edit short subtitle segments

Controls:
- toolbar +/- buttons
- Ctrl/Cmd + mouse wheel over timeline
- optional fit-to-project command

### 8.3 Playhead

The playhead is draggable and synchronized with the player.

Clicking an empty timeline location seeks immediately.

### 8.4 Segment interactions

Supported V2 operations:
- click to select
- drag body to move timing
- drag left/right edge to resize
- split at playhead
- keyboard delete only when the operation is valid and explicit
- snap to playhead, neighboring segment boundaries and configurable small time increments

No overlapping subtitle segments are introduced by automatic operations. If a user drag would create an invalid overlap, the UI clamps or rejects the edit with clear feedback.

### 8.5 Tracks

Tracks:
- video reference strip
- source subtitles
- translated subtitles
- one lane per speaker

Speaker lanes can collapse to reduce vertical height.

Waveform data can be sourced from generated media metadata later. Until then, deterministic waveform placeholders are visually marked as approximate and are not used for timing logic.

## 9. Inspector design

### 9.1 Script tab

Shows:
- source text
- translated text
- start/end/duration
- speaker
- translation provider/result state
- regenerate translation
- copy source/translation
- split at playhead when the current segment is active

Text edits debounce into autosave but update local state immediately.

### 9.2 Characters tab

Shows detected speakers with:
- display name
- stable color
- segment count
- assigned voice
- preview capability state

Renaming a speaker updates all references without changing the stable speaker ID.

### 9.3 Voice tab

Shows actual capability state from the backend.

Possible states:
- available
- unavailable
- provider not configured
- language unsupported
- processing
- failed

Preview and regenerate are only active in states that can truly execute them.

### 9.4 AI tab

Translation modes:
- Workers AI
- Google
- Compare

Compare mode stores both provider outputs and allows the user to choose one without losing the alternative result during the current editing session.

The UI shows provider/model metadata at a secondary level, not as the primary editing content.

## 10. Autosave and persistence

### 10.1 Durable data

Persist at minimum:
- project title
- source/target language
- segment source text
- segment translated text
- speaker assignment
- segment start/end timing
- lip-sync preference
- selected translation provider preference

### 10.2 Autosave behavior

- local edits apply immediately.
- autosave is debounced.
- only the latest project revision is submitted after rapid consecutive changes.
- saving state is visible in the top bar.
- a failed save keeps the project dirty and exposes retry.
- navigation/unload should warn only when there are unsaved durable mutations.

### 10.3 Revision protection

API mutations carry a project revision/version token. Stale writes should fail with a conflict response instead of silently overwriting newer data.

Initial V2 conflict UX:
- show a conflict banner.
- allow reload from server.
- do not attempt automatic complex text merges.

## 11. Backend/API changes

Add or extend endpoints for:

```text
GET    /api/projects/:id
PATCH  /api/projects/:id
GET    /api/projects/:id/segments
PATCH  /api/projects/:id/segments/:segmentId
POST   /api/projects/:id/segments/:segmentId/split
POST   /api/projects/:id/segments/:segmentId/translate
GET    /api/projects/:id/jobs
GET    /api/capabilities
```

The exact route naming may follow existing Hono conventions, but responsibilities must remain separate.

D1 migrations add revision fields and any missing segment timing/provider metadata required by V2.

## 12. Cloud job UX

Long-running actions expose explicit job state:
- queued
- processing
- succeeded
- failed
- cancelled when supported

The frontend polls initially. The API boundary should remain compatible with future SSE/WebSocket progress delivery without changing feature components.

The UI must never infer job success from elapsed time.

## 13. Error handling

Errors are classified into user-facing categories:
- validation
- network
- auth/configuration
- provider capability
- provider execution
- persistence conflict
- media processing

Behavior:
- field-level validation stays near the field.
- operation errors use toast/banner feedback.
- persistent configuration problems show in the relevant inspector capability section.
- retryable cloud operations expose retry.
- destructive retries are never automatic.

## 14. Keyboard and command UX

Initial shortcut set:

```text
Space                 Play / pause
Left / Right          Seek small step
Shift + Left / Right  Seek larger step
S                     Split selected segment at playhead
Cmd/Ctrl + Z          Undo
Cmd/Ctrl + Shift + Z  Redo
Cmd/Ctrl + K          Command palette
+ / -                 Timeline zoom in / out when timeline focused
Escape                Cancel current drag/dialog/palette
```

Shortcuts are ignored while typing in text fields except the standard undo/redo commands appropriate for editor context.

## 15. Accessibility

- Every icon-only control has an accessible label.
- Focus states use a visible tokenized focus ring.
- Keyboard traversal covers timeline toolbar, inspector tabs and top-bar controls.
- Drag operations have keyboard-accessible alternatives for timing adjustments.
- Motion-heavy decorative effects respect `prefers-reduced-motion`.
- Status is not communicated by color alone.

## 16. Performance

### Timeline

Avoid rendering every possible minor ruler tick as a DOM node for long projects. Compute only visible ticks and segments in the viewport when necessary.

### State

Playback time updates should not cause the entire app to rerender. Player/timeline synchronization should isolate high-frequency updates.

### Persistence

Autosave payloads should be mutation-scoped rather than replacing the entire project document.

### Large speaker counts

Speaker lanes support collapse and the character list supports filtering.

## 17. Testing strategy

### Pure unit tests

- timeline time/pixel conversion
- zoom bounds
- snapping
- resize clamping
- segment split
- overlap prevention
- undo/redo history
- autosave debounce/revision rules

### Component tests

- active inspector tab
- capability-disabled voice controls
- player empty/ready/processing states
- save status
- command palette
- segment selection

### Worker tests

- project revision update
- segment timing persistence
- stale revision conflict
- translation job routing
- capability endpoint
- split endpoint validation

### Build/deploy gates

Every PR must pass:
- dependency install
- Node regression tests
- Vitest
- TypeScript build
- Vite production build
- Wrangler dry-run

Production deploy continues from `main` through the existing Cloudflare workflow.

## 18. Delivery phases

### Phase V2.1 — Visual system + shell

- split CSS architecture
- refine top bar/rails/inspector
- responsive panel behavior
- status, toast, skeleton primitives

### Phase V2.2 — Real player + timeline foundation

- real video surface
- playback synchronization
- zoom/scroll/playhead
- tested timing math

### Phase V2.3 — Segment editing

- select/move/resize/split
- snapping
- undo/redo
- timing persistence

### Phase V2.4 — Inspector + AI workflows

- Script/Characters/Voice/AI tabs
- translation modes
- per-segment actions
- capability-aware voice controls

### Phase V2.5 — Autosave + cloud polish

- revisioned persistence
- save/conflict states
- cloud job status
- keyboard shortcuts
- command palette
- accessibility and performance pass

## 19. Acceptance criteria

Studio Pro V2 is complete only when all of the following are true:

1. A real uploaded source video can be played and sought in the studio when a playable source URL is available.
2. Timeline playhead and video current time stay synchronized.
3. A subtitle segment can be selected, moved, resized and split with tested timing constraints.
4. Undo/redo works for supported editor mutations.
5. Durable edits autosave to D1 and expose visible saving/saved/error states.
6. Stale revision writes fail explicitly instead of overwriting newer data.
7. Translation provider mode can be switched between Workers AI, Google and Compare when configured.
8. Voice controls reflect real backend capability state and never fake success.
9. The inspector provides working Script, Characters, Voice and AI tabs.
10. The interface is usable at desktop and medium-width layouts without losing the center-stage editing workflow.
11. Critical editor controls are keyboard reachable and have accessible labels.
12. CI passes tests, typecheck, production build and Wrangler dry-run.
13. Production deploy on `main` keeps `yupvox.qs3d.site` as the canonical domain.
14. Export and visual lip-sync remain clearly unavailable unless their real processing backends are verified.

## 20. Migration and compatibility

Existing projects continue to load. New schema fields use safe defaults. No migration may reinterpret existing segment timestamps or speaker IDs.

The UI may progressively enhance older project records after loading, but any inferred value must be distinguishable from verified media metadata when it affects editing behavior.

## 21. Security and privacy

- API keys remain Cloudflare/GitHub secrets and are never committed.
- Source media stays in the configured R2 bucket.
- Provider requests send only the content required for the requested AI operation.
- Voice cloning remains disabled unless a future provider and consent model are explicitly implemented.
- UI logs must not print provider secrets or signed media credentials.

## 22. Final implementation direction

The canonical implementation approach is a **professional dubbing editor, not a general-purpose video editor**. V2 prioritizes interaction quality, durable edits, trustworthy cloud state and provider transparency. The existing Cloudflare-first architecture remains intact; the major work is upgrading the frontend/editor model and adding the minimal persistence/API capabilities required to make those interactions real.
