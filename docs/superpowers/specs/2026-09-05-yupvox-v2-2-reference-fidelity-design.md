# YupVox Studio Pro V2.2 Reference-Fidelity Reconciliation Design

**Date:** 2026-09-05  
**Status:** Approved in chat for design direction; implementation not started  
**Base:** `main` at `8901ad30feaebe57db75964f2d7a2bb424ba5fca`  
**Reference carrier:** PR #2 / `feat/studio-ui-reference-match`  
**Production composition owner:** current Studio Pro V2.2 on `main`

## 1. Goal

Bring the current YupVox Studio Pro V2.2 desktop experience substantially closer to the supplied 1448×1086 reference image while preserving every production-capable behavior that has already landed on `main`.

The priority order is:

1. preserve working Studio Pro V2.2 behavior and live pipeline contracts;
2. match the reference desktop geometry, density, hierarchy, copy, and visual tone as closely as practical;
3. keep responsive/mobile behavior intact;
4. keep capability claims truthful and avoid re-introducing mock-success controls.

This is a presentation-layer reconciliation, not a rollback to the older PR #2 application architecture.

## 2. Non-negotiable functional invariants

The following current `main` behavior must survive unchanged or with equivalent interfaces:

- R2 multipart upload and project creation;
- Workflow-backed dubbing jobs and progress polling;
- FFmpeg Container media processing;
- Workers AI Whisper ASR and persisted D1 segments;
- Workers AI translation and optional Google/compare retranslation;
- cloud hydration into Studio state;
- private media streaming and HTTP byte-range behavior;
- real HTML video playback;
- player↔timeline synchronization;
- timeline zoom, scroll, direct seek, draggable playhead, and segment selection;
- server-backed source/translation/speaker edits;
- non-destructive compare mode until explicit apply;
- mobile source/inspector drawers and accessibility semantics;
- capability-gated voice, lip-sync, and final-export surfaces.

No reference-fidelity change may substitute static mock state for these flows.

## 3. Chosen approach

Use the current Studio Pro V2.2 component tree as the production source of truth and selectively port visual contracts from PR #2.

Rejected alternatives:

- **Skin-only current UI:** lower risk but insufficiently faithful because geometry and control hierarchy differ materially from the supplied reference.
- **Cherry-pick PR #2 shell wholesale:** visually closer initially, but would overwrite newer composition, live player/timeline behavior, cloud state, persistence, and accessibility work.

The selected approach keeps `App -> StudioShell -> StudioTopbar` and the current feature modules, then changes layout, CSS, copy placement, and compact control presentation around them.

## 4. Desktop reference contract

The visual qualification viewport is exactly **1448×1086**.

Target geometry at that viewport:

- topbar: approximately **76px** high;
- footer/capability strip: approximately **66px** high;
- left rail: approximately **304px** wide;
- right inspector rail: approximately **304px** wide;
- center workspace: fills the remaining width;
- player horizontal bounds: approximately x=320 to x=1128;
- overall desktop columns: approximately **304 / 840 / 304**;
- center content must remain visually dominant, with side rails reading as dense workstation panels rather than spacious dashboard cards.

These are reference targets, not hardcoded viewport-only constants. CSS should use variables and responsive clamping so the 1448×1086 contract is precise while surrounding desktop widths degrade gracefully.

## 5. Topbar design

### 5.1 Branding

Restore the stronger reference branding treatment:

- `YupVox.Com` as the dominant brand label;
- compact `AI Studio Dubbing` sublabel;
- waveform-style brand mark rather than a generic text tile;
- dark near-black topbar with subtle separation and minimal glow.

### 5.2 Project and status hierarchy

The reference prioritizes project identity and export over operational telemetry. Therefore:

- project title remains visible near the brand;
- export remains the primary right-side action;
- save/cloud state remains available but becomes compact;
- undo/redo/history and secondary operational controls may collapse into compact icon groups or a menu at reference width;
- credits/profile may remain visible only if they do not disturb the measured geometry.

Cloud/job progress must remain discoverable and truthful, but it must not widen the topbar enough to break the reference layout.

## 6. Left rail design

The left rail should visually follow PR #2 while using the current live upload/job flow.

Order:

1. media/source heading;
2. large dashed upload drop zone;
3. selected-file or upload/job status card;
4. speaker/character section;
5. source language control;
6. target language control;
7. primary `Bắt đầu Dubbing AI` action;
8. concise explanatory copy.

The upload panel must continue to call the existing cloud upload flow and expose real errors/progress. No disabled Phase-2 placeholder copy should return.

Speaker cards should be denser and closer to the reference: compact avatar, name, short role/meta copy, and waveform-like decoration where feasible without adding fake audio behavior.

Language controls are presentation controls in this reconciliation unless current persisted project language state already supports mutation. They must not pretend to save unsupported values.

## 7. Center stage design

### 7.1 Real player, reference framing

Retain the current real HTML video and media streaming implementation.

Restyle the player to match the reference:

- darker canvas framing;
- tight outer margins;
- rounded media frame;
- subtitle stack centered near the bottom;
- source subtitle visually stronger than translated subtitle;
- thin purple progress treatment;
- compact transport row below media;
- no CSS-art/demo image replacing a loaded production video.

For the demo project where no real media exists, the fallback visual may remain synthetic, but it should visually resemble a cinematic video frame rather than a decorative UI illustration.

### 7.2 Timeline

Retain all V2.2 interactions and math.

Reference styling goals:

- denser vertical tracks;
- subdued ruler and labels;
- purple accent playhead;
- compact segment blocks;
- track label column proportion close to the reference;
- waveform/thumb-strip styling that reads as editing media, not dashboard charts.

The timeline must not lose zoom, scroll, drag, direct seek, or player synchronization.

## 8. Right inspector design

Keep the current persistence/retranslation callbacks and data flow, but restyle the inspector around the reference hierarchy.

Primary structure:

- compact inspector heading;
- script/character tabs where currently supported;
- source-language card;
- separator/swap visual;
- translated-language card;
- translation provider/retranslate controls integrated without expanding the rail excessively;
- voice assignment block;
- lip-sync capability block.

Source and translated text remain editable and server-backed for cloud projects.

Compare mode remains non-destructive. `Workers AI`, `Google`, `So sánh`, `Dịch lại`, and explicit `Áp dụng` remain available, but the controls should use dense sizing consistent with the reference rail.

Voice preview, cloning, lip-sync rendering, and final export must stay capability-aware. Reference copy that implies unavailable capabilities may be shown only as clearly guarded feature language, never as a successful live state.

## 9. Footer / capability strip

At the reference viewport, restore the richer multi-item footer treatment from PR #2 in approximately 66px height.

Preferred visible concepts:

- multilingual dubbing;
- character recognition;
- voice preservation/cloning as capability-gated;
- cloud processing;
- AI voice availability as capability-gated where necessary.

Each item should be compact, icon-led, and visually aligned with the screenshot. Any capability that is not live must use guarded wording or tooltip detail rather than an unconditional success claim.

At smaller breakpoints the footer may reduce to the current compact capability strip or disappear as it does today.

## 10. Styling architecture

Do not reintroduce PR #2's monolithic minified stylesheet as production source.

Instead:

- keep existing token files;
- add or extend semantic YupVox reference tokens for measured desktop geometry;
- keep component-specific CSS with player/timeline modules;
- use `layout.css` for shell-level geometry and responsive rules;
- use a dedicated reference-fidelity stylesheet only if needed for narrow overrides that would otherwise pollute global layout rules;
- prefer CSS variables for topbar/footer/rail sizes;
- avoid fixed positioning except existing mobile drawer behavior.

The implementation should make the 1448×1086 contract easy to inspect from CSS rather than hiding it in scattered magic numbers.

## 11. Responsive behavior

The exact reference contract applies only to desktop qualification at 1448×1086.

Existing responsive behavior remains authoritative below desktop:

- at tablet widths, rails may compress;
- at mobile widths, source and inspector become drawers;
- mobile backdrop and accessibility labels remain;
- footer may collapse or hide;
- player and timeline remain usable without horizontal page overflow.

Reference fidelity must not be achieved by breaking the current mobile composition.

## 12. State and data flow

No new application-level state architecture is introduced.

Current flow remains:

`UploadPanel -> cloudUploadFlow -> process job -> StudioShell polling -> cloud hydration -> studio reducer`

and:

`VideoStage <-> studio playback state <-> Timeline`

and:

`ScriptInspector -> persistence/retranslation helpers -> API -> reducer/UI reconciliation`

Visual-only controls that do not have a persisted backend contract must remain presentation-only or disabled/guarded. No fake optimistic success is permitted for unsupported mutations.

## 13. Error handling

Existing operational failures remain visible:

- upload/process failures stay surfaced;
- cloud job failure remains visible in the shell;
- editor persistence/retranslation failure remains visible in the inspector;
- failed mutations restore cloud state where the current flow already does so;
- media load errors retain a useful fallback state rather than showing a blank frame.

Visual fidelity must not hide errors solely to match the screenshot.

## 14. Accessibility

Preserve current semantic regions and accessible controls:

- labeled source/media rail;
- labeled central editing workspace;
- accessible inspector;
- keyboard-usable playback/timeline controls;
- visible focus states;
- mobile drawer labels;
- disabled/capability-gated controls represented truthfully to assistive technology.

Compact icon controls added for topbar consolidation require `aria-label`/tooltips.

## 15. Testing strategy

### 15.1 Behavior regression

Existing tests must continue to cover:

- player playback state;
- media range route;
- timeline math/interactions;
- cloud hydration and job polling;
- editor persistence and retranslation;
- responsive/mobile shell contracts where currently tested.

### 15.2 New reference-fidelity contracts

Add deterministic tests for desktop presentation invariants rather than screenshot-only brittle assertions. Examples:

- expected reference layout class/hooks are present;
- topbar exposes compact project/export/status hierarchy;
- left rail keeps upload, speakers, language controls, and live dubbing action in order;
- inspector retains translation provider controls and explicit apply behavior;
- footer renders the reference capability items with guarded semantics;
- CSS source contains the canonical reference geometry variables for the 1448×1086 qualification viewport.

### 15.3 Visual qualification

After source tests pass, run a browser screenshot at **1448×1086** against the supplied reference.

Qualification is human/visual plus measured geometry, not a claim of mathematical pixel identity unless an actual image-diff metric is produced.

The final visual pass should specifically inspect:

- topbar height and density;
- 304px side rails;
- player bounds and vertical placement;
- right-inspector density;
- timeline row heights;
- footer height;
- typography scale;
- purple accent intensity;
- unwanted extra status chrome.

## 16. CI and merge gates

Implementation occurs on a fresh feature branch from the current `main` after this spec is approved.

Before merge:

1. RED tests demonstrate each intended visual contract change;
2. implementation turns those tests GREEN;
3. full `npm run verify` passes;
4. Wrangler dry-run passes;
5. exact-head PR CI passes;
6. 1448×1086 screenshot is reviewed against the supplied reference;
7. `main` is rechecked for drift before merge;
8. post-merge `main` CI passes.

Production Cloudflare deployment remains independent/manual while the Container token qualification issue is unresolved.

## 17. Out of scope

This reconciliation does not implement:

- new TTS provider integration;
- voice cloning backend;
- visual lip-sync rendering;
- final dubbed media export pipeline;
- billing/credit accounting;
- authentication/profile systems;
- new language persistence unless already supported by existing APIs;
- a claim of production runtime PASS for Cloudflare Container deployment.

Those belong in separately qualified lanes.

## 18. Completion definition

This work is complete only when the current Studio Pro V2.2 functionality remains intact, the desktop 1448×1086 presentation has been visibly reconciled toward the supplied YupVox reference, full source/build/dry-run CI is GREEN on exact head, and the final merge is verified again on `main`.

The result may be described as **reference-matched / reference-fidelity reconciled** after visual review. It must not be described as `100% pixel-perfect` unless a real pixel-diff comparison supports that statement.
