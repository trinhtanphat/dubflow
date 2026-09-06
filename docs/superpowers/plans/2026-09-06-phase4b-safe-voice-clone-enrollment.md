# Phase 4B Safe Voice Clone Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consent-gated ElevenLabs Instant Voice Clone enrollment, safe lifecycle management, speaker assignment, truthful capability reporting, and Studio controls without deploying production.

**Architecture:** Keep managed clone state in a dedicated `voice_clones` D1 table and isolate provider calls behind `worker/src/services/voice-clone`. Project-scoped routes validate ownership/consent/sample state before a dedicated Cloudflare rate-limit lane; temporary samples live in R2 only until enrollment finishes and are deleted on both success and failure. Existing speaker update logic remains authoritative for voice assignment/invalidation.

**Tech Stack:** TypeScript, Hono, Cloudflare Worker/D1/R2/Rate Limiting, ElevenLabs HTTP API, React, Vitest, Node test, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4b-safe-voice-clone-enrollment-design.md`

## Global Constraints

- Source/CI qualification only; no production deployment.
- Managed enrollment is ElevenLabs IVC only; no PVC training/orchestration.
- Consent/rights attestation is required server-side before sample storage or provider enrollment.
- Never auto-extract source-video audio for cloning.
- Temporary samples must be deleted after provider success or failure; cleanup failures surface as failures.
- Cross-user resources use not-found semantics.
- Clone rate limiting is separate from ordinary voice TTS and does not write Phase 3B usage events.
- Only `ready` clones may be assigned to speakers.
- Raw provider bodies, secrets, samples, transcript text and filenames are excluded from persistence/telemetry.

---

### Task 1: Acceptance gate, schema, and domain repository

**Files:**
- Create: `tests/phase4b-voice-clone-acceptance.test.mjs`
- Modify: `package.json`
- Create: `migrations/0007_voice_clones.sql`
- Create: `worker/src/db/voice-clones.ts`
- Modify: `worker/src/cloudflare/r2.ts`

**Interfaces:**
- Produces `VoiceClone`, `VoiceCloneStatus`, `VoiceCloneRepository` with owner-scoped create/list/get/status/update/delete-support methods.
- Produces R2 `delete(key)` support required by enrollment cleanup.

- [ ] Write the acceptance test first. It must assert the migration/table/status contract, dedicated `RATE_LIMIT_VOICE_CLONE`, `voice-clone` service/route files, consent version constant, cleanup error code, capability `cloneEnrollment`, and documentation boundary.
- [ ] Add the acceptance test to `verify:deploy-config`; push and verify CI RED because implementation files/config do not yet exist.
- [ ] Add migration `0007_voice_clones.sql` with the exact status check from the spec, project/status index, and partial unique provider identity index.
- [ ] Implement the repository with owner-scoped reads and stable `VoiceClonePersistenceError` codes; never expose records across users.
- [ ] Extend `R2BucketLike` with optional `delete(key: string): Promise<void>`.
- [ ] Run/push CI and require repository/unit/type checks to become GREEN before moving on.

### Task 2: Provider adapter and safe sample enrollment service

**Files:**
- Create: `worker/src/services/voice-clone/types.ts`
- Create: `worker/src/services/voice-clone/elevenlabs.ts`
- Create: `worker/src/services/voice-clone/enrollment.ts`
- Create: `worker/test/voice-clone-provider.test.ts`
- Create: `worker/test/voice-clone-enrollment.test.ts`

**Interfaces:**
- `createInstantClone({name, sample, contentType}): Promise<{providerVoiceId:string; requiresVerification:boolean}>`
- `deleteClone(providerVoiceId:string): Promise<void>`
- `enrollVoiceClone(input): Promise<VoiceClone>` where cleanup is mandatory and cleanup failure throws `VOICE_CLONE_SAMPLE_CLEANUP_FAILED`.

- [ ] Write provider tests first: multipart request contains `name` and one bounded file, success parses `voice_id`/`requires_verification`, provider failures return stable internal errors without raw body leakage, and delete uses the encoded provider ID.
- [ ] Write enrollment tests first: provider success maps to `ready` or `verification_required`; provider failure maps to bounded failed state; sample deletion runs on success/failure; cleanup failure is surfaced and never returned as ready.
- [ ] Push tests and verify RED before implementation.
- [ ] Implement provider adapter with ElevenLabs endpoints and bounded errors.
- [ ] Implement enrollment orchestration with a `finally` cleanup path and no usage writes.
- [ ] Push and require focused tests GREEN.

### Task 3: API, admission ordering, assignment, and deletion

**Files:**
- Create: `worker/src/routes/voice-clones.ts`
- Modify: `worker/src/routes/speakers.ts`
- Modify: `worker/src/db/speakers.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/security/rate-limit.ts`
- Modify: `wrangler.jsonc`
- Create: `worker/test/voice-clone-routes.test.ts`

**Interfaces:**
- Routes: list/create/sample/enroll/delete and explicit clone-to-speaker assignment from the spec.
- Dedicated limiter lane `voice-clone` -> `RATE_LIMIT_VOICE_CLONE`.
- Speaker repository gains an assignment-clear helper used by managed clone deletion while preserving current invalidation semantics.

- [ ] Write route tests first for consent rejection, ownership hiding, sample validation, rate-limit-before-mutation/provider ordering, verification-required assignment rejection, ready assignment, deletion fail-closed behavior, and clearing assigned speakers before provider delete.
- [ ] Push and verify RED.
- [ ] Add `RATE_LIMIT_VOICE_CLONE` to Env and Wrangler with a unique namespace and bounded per-minute limit.
- [ ] Add the lane to rate-limit dispatch without changing existing five lanes.
- [ ] Implement project-scoped routes with exact validation/admission ordering.
- [ ] Reuse speaker invalidation logic for assignment/clear rather than direct SQL that bypasses segment/export invalidation.
- [ ] Mount the route from `worker/src/index.ts`.
- [ ] Push and require route tests/typecheck GREEN.

### Task 4: Truthful capability contract and Studio management surface

**Files:**
- Modify: `worker/src/services/voice/elevenlabs.ts`
- Modify: `worker/src/services/voice/workers-ai.ts`
- Modify: `worker/src/routes/voice.ts`
- Modify: `src/features/voice/voiceApi.ts`
- Create: `src/features/voice/voiceCloneApi.ts`
- Create: `src/features/voice/VoiceCloneManager.tsx`
- Create: `src/features/voice/VoiceCloneManager.test.tsx`
- Modify: `src/app/StudioShell.tsx`

**Interfaces:**
- `VoiceCapabilities.cloneEnrollment = {provider:'elevenlabs'; mode:'ivc'; available:boolean}`.
- Legacy `cloning` reflects managed enrollment availability only.
- Studio manager lists lifecycle states and only enables assignment for `ready`.

- [ ] Write UI/API tests first for unavailable, consent-disabled, creating, verification-required, ready, failed and deleting/deleted truthfulness.
- [ ] Push and verify RED.
- [ ] Change capability semantics so ordinary TTS configuration alone is not an unqualified cloning claim; expose explicit `cloneEnrollment`.
- [ ] Implement API client for clone lifecycle calls.
- [ ] Implement compact `VoiceCloneManager` and mount it inside the existing voice/speaker workflow without restructuring the workstation.
- [ ] Push and require UI tests plus reference screenshot CI GREEN.

### Task 5: Documentation, full qualification, review, and merge

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment-status.md`
- Update acceptance/docs tests if necessary without weakening prior gates.

**Interfaces:**
- Documentation explicitly states source/CI qualification only, IVC scope, consent requirement, PVC exclusion, manual-only production deploy, and runtime UNQUALIFIED.

- [ ] Update README/deployment status with Phase 4B boundaries and remove any stale claim that cloning is already qualified.
- [ ] Run exact-head CI: acceptance, Node tests, full Vitest, TypeScript/Vite build, Wrangler dry-run, screenshot capture/upload.
- [ ] Compare branch against live main and self-review changed files for Critical/Important issues; fix via TDD if found.
- [ ] Open PR from `feat/phase4b-safe-voice-clone-enrollment` to `main` and require fresh PR CI GREEN.
- [ ] Re-check live main for drift and merge only with the exact expected head SHA.
- [ ] Poll post-merge push CI on the merge SHA until completed/success. If it fails, fix on a follow-up branch/PR rather than mutating main directly.
- [ ] Do not trigger production deployment.
