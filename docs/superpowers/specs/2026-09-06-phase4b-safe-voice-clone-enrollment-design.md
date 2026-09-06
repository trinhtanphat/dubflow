# Phase 4B — Safe Voice Clone Enrollment Design

Date: 2026-09-06
Status: Approved for implementation
Baseline main SHA: `4cb3e35c14681179da612772ed3a3c4fc3f601f3`

## 1. Goal

Add a real, consent-gated managed voice-clone enrollment workflow for YupVox instead of merely reporting cloning capability when an ElevenLabs TTS voice ID is configured.

Phase 4B is source/CI qualification only. It must not deploy production and must not claim production voice-cloning qualification. Production remains manual-only and runtime remains UNQUALIFIED until the existing Cloudflare Container credential and real provider/media fixture gates pass.

## 2. Scope

Phase 4B implements:

- ElevenLabs Instant Voice Clone (IVC) enrollment from an explicit user-provided audio sample.
- explicit consent/rights attestation before sample upload or provider enrollment;
- owner/project-scoped clone records and lifecycle state;
- fail-closed provider creation and deletion;
- temporary R2 sample storage with cleanup after the provider attempt;
- clone assignment to an existing project speaker only when the clone is usable;
- capability reporting that distinguishes ordinary TTS preview from managed clone enrollment;
- dedicated clone-enrollment abuse control, telemetry and source acceptance tests;
- truthful Studio UI for clone creation, pending verification, failure, ready and deletion states.

Phase 4B does not implement:

- Professional Voice Clone (PVC) creation or training orchestration;
- provider CAPTCHA/manual verification UX;
- automatic extraction of a speaker voice from uploaded source video for cloning;
- silent or automatic cloning from ASR/diarization output;
- cloning another person's PVC through YupVox;
- custom voice-cloning models;
- production deployment or live qualification.

A user may still assign a pre-existing provider voice ID through the existing speaker voice assignment path. PVCs or shared provider voices therefore remain bring-your-own-provider-voice concerns, not managed Phase 4B enrollment.

## 3. Provider contract

The managed provider for Phase 4B is ElevenLabs IVC.

Current provider contract used by this design:

- IVC creation uses `POST /v1/voices/add` with multipart audio files and a required name.
- A successful response yields `voice_id` and `requires_verification`.
- Provider voice deletion uses `DELETE /v1/voices/:voice_id`.

YupVox must wrap these calls behind a dedicated clone provider boundary. Route and persistence code must not construct ElevenLabs requests directly.

## 4. Safety and consent boundary

Managed clone enrollment is opt-in and explicit.

Before any sample is stored or sent to ElevenLabs, the request must include the current consent attestation version and an affirmative acknowledgement that the user has the rights and consent required to create and use the clone.

The server, not the browser alone, enforces this requirement.

The managed workflow must never infer consent from:

- project ownership;
- speaker presence in a source video;
- a speaker display name;
- previous voice assignment;
- prior preview playback;
- diarization identity;
- a generic terms checkbox unrelated to clone enrollment.

No source-video audio is automatically extracted into the clone workflow. The user must intentionally provide the enrollment sample.

## 5. Data model

Add a new D1 table `voice_clones` rather than overloading the existing `speakers` table.

Required columns:

- `id TEXT PRIMARY KEY`
- `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `provider TEXT NOT NULL CHECK (provider = 'elevenlabs')`
- `provider_voice_id TEXT`
- `name TEXT NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('creating','verification_required','ready','failed','deleting','deleted'))`
- `consent_version TEXT NOT NULL`
- `consented_at TEXT NOT NULL`
- `error_code TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Indexes:

- project/status index for Studio listing;
- unique provider identity when `provider_voice_id` is non-null.

Do not persist:

- sample bytes in D1;
- provider API keys;
- bearer URLs;
- raw provider response bodies;
- transcript text;
- source media paths as clone provenance.

The existing `speakers.voice_provider` and `speakers.voice_id` remain the synthesis assignment fields. A ready clone is assigned by writing `voice_provider='elevenlabs'` and its provider voice ID through the existing speaker update/invalidation behavior.

## 6. Clone lifecycle

Canonical states:

### `creating`

A durable clone record exists and provider enrollment has not completed.

### `verification_required`

ElevenLabs created a voice ID but reported `requires_verification=true`. YupVox must persist the provider voice ID for cleanup/status purposes, but the clone cannot be assigned to a speaker or used for synthesis through the managed clone UI.

Phase 4B does not implement the provider verification ceremony. The UI explains that verification must be completed through the provider before managed assignment can be qualified in a later phase.

### `ready`

The provider returned a voice ID and did not require verification. The clone may be assigned to a speaker.

### `failed`

Creation failed. Persist only a bounded stable error code/message class, never a raw provider body containing sensitive material.

### `deleting`

Deletion has begun and the clone is not assignable.

### `deleted`

Provider deletion succeeded or there was no provider voice ID to delete. A deleted clone remains as a bounded audit/lifecycle record but is excluded from assignable lists.

## 7. Temporary sample storage

The browser uploads a clone sample through an owner-authorized route into R2 under a temporary key such as:

`projects/{projectId}/voice-clones/{cloneId}/sample/{uploadId}`

The key is server-generated. Client filenames never become authoritative object keys.

The sample must be bounded by server-side validation before provider enrollment. Phase 4B accepts common spoken-audio media types supported by the provider and rejects empty, oversized or unsupported payloads. The implementation plan must lock exact byte/type bounds in tests and config constants rather than scattering magic values.

The sample is temporary. After a provider enrollment attempt finishes, YupVox must attempt R2 deletion in a `finally`-style cleanup path for both success and failure.

If sample cleanup fails after provider creation succeeds, the clone must not be reported as fully successful until the cleanup failure is surfaced for retry/repair. Cleanup correctness is part of the security contract, not best effort.

## 8. API surface

Add project-scoped clone routes:

- `GET /api/projects/:id/voice-clones`
- `POST /api/projects/:id/voice-clones`
- `POST /api/projects/:id/voice-clones/:cloneId/sample`
- `POST /api/projects/:id/voice-clones/:cloneId/enroll`
- `DELETE /api/projects/:id/voice-clones/:cloneId`
- `POST /api/projects/:id/speakers/:speakerId/voice-clone/:cloneId`

The create route records metadata and consent only. The sample route stores a bounded temporary sample. The enroll route performs the provider call from the temporary R2 object and then cleanup. Separating these operations keeps multipart handling and provider state transitions independently testable.

All project/clone/speaker resources are owner scoped. Cross-user access and missing ownership must remain hidden behind the existing not-found semantics rather than exposing resource existence.

## 9. Admission ordering and abuse controls

Use a dedicated clone-enrollment Cloudflare Rate Limiting binding, separate from normal voice preview/TTS generation.

Required order for enrollment:

1. authenticate/derive server actor identity;
2. verify project ownership;
3. verify clone ownership and lifecycle state;
4. verify affirmative consent record;
5. verify a valid temporary sample exists and satisfies bounds;
6. consume clone-enrollment rate limit;
7. mutate lifecycle to `creating` if needed;
8. call provider;
9. persist provider result;
10. delete temporary sample;
11. return the bounded clone resource.

A rate-limit rejection must happen before provider calls, usage writes or lifecycle mutation.

The clone lane is an abuse/admission control only. It must not decrement credits or create payment/quota semantics.

## 10. Provider adapter

Create a dedicated service boundary, for example:

`worker/src/services/voice-clone/types.ts`
`worker/src/services/voice-clone/elevenlabs.ts`

The adapter exposes explicit operations such as:

- `createInstantClone(input): Promise<{ providerVoiceId: string; requiresVerification: boolean }>`
- `deleteClone(providerVoiceId): Promise<void>`

Provider failures are converted into stable internal error codes. Raw provider bodies may be inspected only long enough to classify a bounded error and must not be persisted or emitted to telemetry.

## 11. Capability semantics

The current capability contract must stop treating `cloning: true` as equivalent to "ElevenLabs TTS is configured".

Replace or extend the public capability payload with an explicit clone enrollment capability, for example:

```ts
{
  provider: 'elevenlabs',
  configured: true,
  languages: ['vi'],
  preview: true,
  cloneEnrollment: {
    provider: 'elevenlabs',
    mode: 'ivc',
    available: true
  }
}
```

When ElevenLabs is not configured, `cloneEnrollment.available` is false.

Legacy consumers may temporarily receive a `cloning` field only if its semantics are changed to reflect managed enrollment availability, not generic provider capability.

## 12. Speaker assignment and invalidation

Only clones in `ready` state are assignable.

Assignment must reuse the existing speaker persistence path so the current media invalidation behavior remains authoritative:

- changing a speaker voice invalidates previously generated dubbed audio for that speaker;
- any published project export is invalidated before the next render;
- renaming a speaker does not invalidate audio.

`verification_required`, `creating`, `failed`, `deleting` and `deleted` clones are rejected with stable conflict/validation semantics and never written to `speakers.voice_id`.

Deleting a clone that is currently assigned to one or more speakers must first clear those assignments through the same invalidation path, then delete the provider voice. The operation must not leave a speaker pointing at a provider voice that YupVox reports as deleted.

## 13. Deletion semantics

Deletion is fail-closed.

When a provider voice ID exists:

1. mark the clone `deleting` in an allowed transition;
2. clear project speaker assignments that reference that exact managed clone, invalidating generated media/export as required;
3. call provider delete;
4. only after provider success mark the clone `deleted`.

If provider deletion fails, persist a bounded failure condition and keep the clone non-assignable. Do not return a false deleted success.

If no provider voice ID was ever created, deletion may mark the local record `deleted` without a provider call after any temporary sample is removed.

## 14. Telemetry and usage accounting

Emit only bounded operational metadata:

- request ID;
- opaque actor/project/clone identifiers;
- operation;
- provider;
- status;
- latency;
- stable error code.

Never emit:

- sample bytes;
- sample object URLs/keys if avoidable;
- provider API keys;
- raw provider response bodies;
- transcript/source text;
- consent free text;
- voice sample filenames.

Phase 3B usage remains the accounting source of truth for ASR, translation, generated TTS audio and render. Phase 4B clone enrollment/deletion is not added to billable usage in this phase.

## 15. Studio UX

Add a compact voice-clone management surface within the existing speaker/voice workflow rather than creating a separate application area.

Required states:

- provider unavailable: show clone enrollment unavailable without a fake action;
- consent not acknowledged: enrollment disabled;
- sample selected/uploading;
- ready to enroll;
- creating;
- verification required;
- ready;
- failed with safe retry guidance;
- deleting/deleted.

A ready clone exposes an explicit `Assign to speaker` action. Assignment is never automatic after enrollment.

The UI must not claim that a voice is cloned or usable before the server lifecycle says `ready`.

## 16. Error handling

Use stable internal codes for at least:

- `VOICE_CLONE_PROVIDER_UNCONFIGURED`
- `VOICE_CLONE_CONSENT_REQUIRED`
- `VOICE_CLONE_SAMPLE_REQUIRED`
- `VOICE_CLONE_SAMPLE_INVALID`
- `VOICE_CLONE_STATE_CONFLICT`
- `VOICE_CLONE_PROVIDER_FAILED`
- `VOICE_CLONE_VERIFICATION_REQUIRED`
- `VOICE_CLONE_SAMPLE_CLEANUP_FAILED`
- `VOICE_CLONE_DELETE_FAILED`
- `VOICE_CLONE_NOT_FOUND`

Provider HTTP status/body text must not become user-visible verbatim.

## 17. Testing and qualification

Phase 4B acceptance must prove at source/CI level:

1. clone capability is not claimed merely because ordinary ElevenLabs TTS is configured;
2. consent is required server-side before storage/provider enrollment;
3. cross-user project/clone/speaker access is hidden;
4. provider creation receives the expected bounded multipart sample and name;
5. `requires_verification=true` persists `verification_required` and cannot be assigned;
6. provider success without verification requirement persists `ready`;
7. temporary R2 sample cleanup runs after both provider success and failure;
8. cleanup failure is surfaced and not silently treated as fully successful;
9. clone assignment reuses existing speaker voice invalidation semantics;
10. deleting an assigned clone clears/invalidate assignments before provider deletion;
11. provider delete failure does not report the clone as deleted;
12. rate limiting occurs after authorization/validation but before provider calls/mutation;
13. clone rate limiting does not write Phase 3B usage events;
14. telemetry excludes sample/secret/raw provider payload material;
15. Studio states remain truthful for unavailable, verification-required, ready, failed and deleting states;
16. TypeScript/Vitest/build/Wrangler dry-run and existing screenshot acceptance stay GREEN.

No source/CI test may be described as production provider qualification.

## 18. Documentation and rollout boundary

Update README and `docs/deployment-status.md` to state:

- Phase 4B source support for managed ElevenLabs IVC enrollment exists;
- consent/rights attestation is mandatory;
- PVC creation/verification/training remains out of scope;
- production clone runtime remains UNQUALIFIED until a real authorized provider fixture is run;
- production deployment remains manual-only;
- no production deploy is performed by this phase.

## 19. External provider references

Design checked against current ElevenLabs documentation on 2026-09-06:

- IVC create API: `POST /v1/voices/add`, returning `voice_id` and `requires_verification`.
- Voice delete API: `DELETE /v1/voices/:voice_id`.
- ElevenLabs documentation states voice verification is an ethical/legal safeguard and PVCs may only be created for the account owner's own voice; sharing a separately created/verified PVC is the supported path for another user's voice.

Provider behavior can change. The adapter and tests must isolate these contracts so later provider changes do not leak into YupVox domain semantics.
