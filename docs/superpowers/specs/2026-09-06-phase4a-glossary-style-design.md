# Phase 4A — Project Glossary and Translation Style Presets

Date: 2026-09-06
Status: Approved in chat; awaiting written-spec review
Base at branch creation: `caee266d01c8dc8194e9d3abf57dc6908dfd92c6`
Branch: `feat/phase4a-glossary-style`

## 1. Goal

Add project-scoped translation context so YupVox can translate recurring names and terminology consistently and apply an explicit writing style without changing segment identity, timing, speaker assignment, or Phase 3B accounting semantics.

Phase 4A contains two user-facing capabilities:

1. project glossary entries mapping a source term to a preferred Vietnamese translation;
2. a project translation style preset: `neutral`, `natural`, `formal`, `casual`, or `cinematic`.

The feature must be honest about provider capabilities. Existing raw Workers AI M2M100 and Google Basic Translation v2 paths do not understand the new project context and must never silently claim that they applied glossary or style instructions.

## 2. Scope boundaries

In scope:

- D1 persistence for style, glossary, translation-context revision, and per-segment contextual provenance;
- owner-authorized settings and glossary APIs;
- optimistic context concurrency;
- a translation-context resolver;
- a prompt-capable contextual Workers AI provider behind the existing AI binding;
- full-pipeline and single-segment retranslation integration;
- a compact Studio translation-settings UI;
- TDD, source acceptance guards, exact-head CI, PR qualification, merge, and post-merge CI.

Out of scope:

- Phase 3C observability/rate-limit/share work;
- diarization;
- voice assignment, preview, cloning, or lip-sync;
- batch/multi-language export;
- Google Advanced Translation glossary resource provisioning;
- automatic mass retranslation when context changes;
- billing, pricing, payment, quota, or credit-debit policy changes;
- production deployment or production-runtime qualification.

Production remains UNQUALIFIED until the separate Cloudflare Container credential and live provider/media fixture gates are satisfied.

## 3. Current architecture constraints

The existing translation provider contract accepts translation items plus source/target language. The current Workers AI provider uses `@cf/meta/m2m100-1.2b` with structured translation inputs (`text`, `source_lang`, `target_lang`); it is not a prompt-driven contextual translation surface. The Google provider uses Basic Translation v2. The router currently supports `workers-ai`, `google`, and `compare`.

The current segment persistence contract records `translation_engine` as `workers-ai` or `google`. Phase 4A must not rebuild the existing `segments` table merely to add a router mode. Contextual translation is therefore represented as a distinct router mode backed by Workers AI, while segment provenance is recorded separately through a nullable context-revision column.

## 4. Canonical domain model

### 4.1 Translation style

Canonical values:

- `neutral`
- `natural`
- `formal`
- `casual`
- `cinematic`

`neutral` is the default and preserves existing behavior when the project has no glossary entries.

### 4.2 Translation context

```ts
export type TranslationStyle = 'neutral' | 'natural' | 'formal' | 'casual' | 'cinematic';

export type TranslationContext = {
  revision: number;
  style: TranslationStyle;
  glossary: Array<{
    id: string;
    sourceTerm: string;
    preferredTranslation: string;
    note?: string;
    caseSensitive: boolean;
  }>;
};
```

The resolver returns one immutable snapshot per logical translation operation.

### 4.3 Context revision

Each project gains `translation_context_revision INTEGER NOT NULL DEFAULT 1`.

Every successful mutation that changes canonical context state increments that revision exactly once:

- style change;
- glossary create;
- glossary update;
- glossary delete.

An idempotent no-op update returns canonical state without incrementing revision.

Context revision is independent from `segment.version`. It must never be used as a substitute for segment optimistic concurrency.

## 5. D1 schema

Add migration `migrations/0006_translation_context.sql`.

Projects gain:

- `translation_style TEXT NOT NULL DEFAULT 'neutral'` with a CHECK over the canonical styles;
- `translation_context_revision INTEGER NOT NULL DEFAULT 1 CHECK (translation_context_revision >= 1)`.

Segments gain:

- `translation_context_revision INTEGER CHECK (translation_context_revision IS NULL OR translation_context_revision >= 1)`.

A `NULL` segment context revision means the persisted translation came from a non-contextual/raw path or predates Phase 4A. A non-null value identifies the exact project context snapshot used by contextual translation. `translation_engine` remains `workers-ai` for contextual translation because the backing provider is Workers AI; the separate revision field is the contextual provenance marker.

Add `project_glossary_entries` with:

- `id TEXT PRIMARY KEY`;
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`;
- `source_term TEXT NOT NULL`;
- `source_term_key TEXT NOT NULL`;
- `preferred_translation TEXT NOT NULL`;
- `note TEXT`;
- `case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0,1))`;
- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`;
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`.

Create an index for project listing and a unique constraint/index on `(project_id, source_term_key, case_sensitive)`.

Canonical `source_term_key` generation is explicit:

1. trim;
2. Unicode normalize with `NFKC`;
3. if `caseSensitive === false`, apply JavaScript Unicode `toLowerCase()`;
4. if `caseSensitive === true`, retain normalized case.

This gives deterministic duplicate detection rather than relying on SQLite collation defaults.

## 6. Validation rules

Server-side validation is authoritative.

- style must be one of the five canonical values;
- `sourceTerm`: trimmed, non-empty, max 120 Unicode characters;
- `preferredTranslation`: trimmed, non-empty, max 200 Unicode characters;
- `note`: optional, max 300 Unicode characters;
- max 200 glossary entries per project;
- duplicate canonical term in the same project and case-sensitivity class returns `409 GLOSSARY_ENTRY_CONFLICT`;
- creating entry 201 returns `409 GLOSSARY_LIMIT_REACHED`;
- the serialized contextual request payload is capped at 128 KiB UTF-8; oversize context returns `400 TRANSLATION_CONTEXT_TOO_LARGE` before provider invocation;
- malformed payload returns `400`;
- inaccessible/missing project or glossary entry returns `404` without leaking cross-user existence.

Frontend validation mirrors these limits for UX only.

## 7. Repository and atomicity contract

Create a focused translation-context repository rather than extending unrelated segment logic.

Required operations:

- read settings for an owned project;
- list glossary for an owned project;
- create/update/delete glossary entry;
- update style;
- resolve the full context snapshot.

Every mutation receives `expectedContextRevision`.

The repository must atomically:

1. verify project ownership;
2. compare the current context revision;
3. perform the mutation when canonical state changes;
4. increment context revision exactly once for a real change;
5. return the new canonical context/settings state.

A stale revision returns `409 TRANSLATION_CONTEXT_CONFLICT` with the full canonical context snapshot needed for client recovery. Failed mutations must not increment revision.

## 8. API surface

Owner-only routes:

- `GET /api/projects/:id/translation-settings`
- `PATCH /api/projects/:id/translation-settings`
- `GET /api/projects/:id/glossary`
- `POST /api/projects/:id/glossary`
- `PATCH /api/projects/:id/glossary/:entryId`
- `DELETE /api/projects/:id/glossary/:entryId`

Mutation payloads include `expectedContextRevision`, including a JSON body for DELETE.

The API never accepts client-supplied `userId`; authorization is derived from the current server-side user boundary.

Representative settings response:

```json
{
  "stylePreset": "natural",
  "contextRevision": 7,
  "contextualAvailable": true
}
```

Glossary responses include the canonical project context revision so the client can update its optimistic guard after each mutation.

## 9. Provider capability and persistence model

Router modes become:

- `workers-ai`: raw M2M100 translation;
- `google`: Google Basic Translation v2;
- `compare`: compare the two raw providers;
- `contextual`: prompt-capable contextual translation.

Provider implementations remain isolated:

- raw `WorkersAITranslationProvider`;
- `GoogleCloudTranslationProvider`;
- new `ContextualWorkersAITranslationProvider`.

The contextual provider uses the existing Workers AI binding and a configurable `CONTEXT_TRANSLATION_MODEL` environment value. If that value is absent/blank, contextual translation is unavailable and no fake fallback is allowed.

Provider/router capability must be queryable/testable so UI and routes can expose availability honestly.

Persistence semantics:

- raw Workers AI result: `translation_engine='workers-ai'`, `translation_context_revision=NULL`;
- raw Google result: `translation_engine='google'`, `translation_context_revision=NULL`;
- contextual Workers AI result: `translation_engine='workers-ai'`, `translation_context_revision=<snapshot revision>`;
- compare mode does not persist a selected translation until an explicit choice follows existing compare semantics.

`SegmentStore.setTranslationResult` is extended with an optional contextual revision rather than widening the engine enum to a synthetic `contextual` value.

## 10. Mode selection semantics

If project context is inactive (`style === 'neutral'` and glossary is empty), existing default translation behavior remains unchanged.

When context is inactive, an explicit `contextual` request is allowed if the contextual provider is configured; it uses the current neutral/empty snapshot and records that context revision.

If project context is active (non-neutral style or at least one glossary entry):

- full pipeline defaults to `contextual`;
- segment retranslate with no explicit mode derives `contextual`;
- explicit `contextual` is allowed when configured;
- explicit `workers-ai`, `google`, or `compare` returns `409 TRANSLATION_CONTEXT_UNSUPPORTED` instead of silently discarding active context.

If `contextual` is requested or derived while the contextual model is unavailable, return `503 CONTEXT_TRANSLATION_UNAVAILABLE`.

No automatic fallback to a raw provider is permitted when contextual semantics were requested or active context must be honored.

## 11. Contextual prompt-safety contract

Source text, glossary terms, preferred translations, and glossary notes are untrusted data, not instructions.

The contextual provider must:

- keep system/instruction text separate from serialized user/project data;
- use a bounded structured payload;
- require machine-readable output containing only segment IDs and translated text;
- reject missing, extra, foreign, or duplicate IDs;
- reject malformed output;
- never accept timing, speaker, source-text, or segment-identity mutations from the model;
- map output back to the exact request IDs before persistence;
- avoid logging source text, translated text, or glossary payloads.

Canonical contextual failures:

- `503 CONTEXT_TRANSLATION_UNAVAILABLE`;
- `400 TRANSLATION_CONTEXT_TOO_LARGE` before provider invocation;
- `502 CONTEXT_TRANSLATION_INVALID` for malformed model output;
- `502 CONTEXT_TRANSLATION_ID_MISMATCH` for missing/extra/duplicate/foreign IDs.

## 12. Translation data flow

For both full workflow translation and single-segment retranslation:

1. authorize project;
2. load one immutable `TranslationContext` snapshot;
3. derive/validate translation mode;
4. validate the 128 KiB contextual payload bound when contextual mode is selected;
5. invoke the selected provider;
6. validate exact result ID correspondence;
7. persist translated text using existing segment optimistic-version semantics;
8. persist `translation_context_revision` only for contextual translation;
9. return the context revision used by contextual translation in API/result metadata.

If glossary/style changes while a provider call is running, that call completes against the snapshot loaded at step 2. Future operations use the new revision.

A context revision change does not invalidate a segment version by itself. A segment version conflict before persistence still returns the existing segment conflict response.

## 13. Usage/accounting behavior

Phase 3B `usage_events` remains the accounting source of truth.

Translation usage continues to count source Unicode characters using the canonical `translation_character` unit. Context metadata does not create a new billing unit and does not change credit balance.

Retries/replays must preserve existing idempotency guarantees and must not create duplicate usage accounting merely because context is enabled.

## 14. Studio UI

Add focused translation UI under `src/features/translation/` rather than mixing glossary state into timeline, voice, or speaker modules.

The Studio exposes a compact **Translation Settings** area containing:

### Style preset

- Trung tính
- Tự nhiên
- Trang trọng
- Thân mật
- Điện ảnh

Show contextual-provider capability clearly:

- contextual translation available;
- contextual translation not configured.

### Glossary editor

Columns/fields:

- source term;
- preferred Vietnamese translation;
- optional note;
- case-sensitive toggle.

Capabilities:

- add/edit/delete;
- local search/filter;
- visible `x / 200` count;
- loading, save, error, and conflict states.

Saving context is independent from segment autosave.

When style/glossary changes, show a lightweight “Translation settings changed” state. Do not automatically retranslate all existing segments. The user explicitly retranslates a segment or reruns processing to use the new context revision.

On `TRANSLATION_CONTEXT_CONFLICT`, replace local stale state with the canonical snapshot returned by the server and require the user to retry their intended mutation; do not last-write-win silently.

## 15. Error handling

- context configuration failures do not partially persist translated text;
- contextual provider failures do not fall back silently;
- raw provider modes do not claim contextual support;
- cross-user resources remain hidden behind 404;
- context mutation conflicts return 409 with canonical state;
- provider internals/secrets are not surfaced in generic API errors;
- no source/glossary content is added to telemetry/logging as part of this phase.

## 16. TDD and acceptance plan

Implementation follows RED → minimal GREEN for each layer.

### Task 1 — Migration/repository

Tests first for:

- default style/revision;
- nullable segment contextual provenance;
- owner-scoped CRUD;
- validation and max 200 entries;
- canonical duplicate protection;
- atomic revision increment;
- no-op does not increment revision;
- stale-revision conflict;
- failed mutation does not increment revision.

### Task 2 — Context resolver

Tests first for:

- immutable snapshot;
- deterministic glossary ordering;
- canonical revision;
- 128 KiB input size bound;
- owner isolation.

### Task 3 — Provider contract/contextual provider

Tests first for:

- raw providers do not advertise context support;
- contextual availability follows configuration;
- exact ID preservation;
- malformed/foreign/missing/duplicate output fails closed;
- active/requested context never falls back to raw translation;
- persisted engine/context revision truthfully distinguish raw from contextual results.

### Task 4 — Routes and segment retranslation

Tests first for:

- settings/glossary CRUD;
- cross-user 404;
- validation/status codes;
- context conflict 409;
- derived contextual mode;
- explicit raw mode rejected while context is active;
- explicit contextual mode allowed for inactive context when configured;
- unavailable contextual provider 503.

### Task 5 — Full workflow integration

Tests first for:

- one context snapshot per logical translation operation;
- active context selects contextual provider;
- inactive context preserves existing raw default behavior;
- source-character usage accounting remains canonical and idempotent.

### Task 6 — Frontend

Tests first for:

- style selector and capability state;
- glossary list/add/edit/delete;
- client-side validation;
- loading/error/conflict handling;
- count/search behavior;
- no automatic mass retranslation.

### Task 7 — Source acceptance and documentation

Add a Phase 4A source acceptance test that locks:

- canonical style enum;
- project context revision and migration presence;
- nullable segment contextual provenance;
- glossary limits and 128 KiB bound;
- contextual provider fail-closed contract;
- raw providers do not silently consume context;
- Phase 3B translation units remain unchanged;
- no scope creep into billing, Phase 3C, voice, or diarization.

Update deployment/status documentation to describe Phase 4A as source-qualified only after exact-head CI is green. Production runtime remains UNQUALIFIED.

## 17. CI, review, and merge gates

For each meaningful TDD unit:

1. commit RED test evidence;
2. run exact-head CI and verify the intended failure;
3. apply minimal production fix;
4. re-run exact-head CI.

Before integration:

1. full exact-head CI must pass tests/build, Wrangler dry-run, screenshot setup, reference screenshots, and artifact upload;
2. perform focused review of the final diff;
3. open/reuse one PR only;
4. re-read live `main` immediately before merge;
5. if `main` advanced, reconcile non-force and requalify the new exact head;
6. merge only with expected-head SHA protection;
7. require post-merge `main` CI to complete successfully.

No production deploy is part of Phase 4A.

## 18. Success criteria

Phase 4A is complete when:

1. an owner can configure a project style preset and up to 200 glossary entries;
2. mutations are revision-guarded and cross-user access is hidden;
3. contextual translation honors an immutable project-context snapshot;
4. raw translation modes never silently discard active context;
5. model output cannot alter segment identity/timing/speaker/source text;
6. raw versus contextual persisted translations remain distinguishable through engine plus nullable context revision;
7. segment and full-workflow translation both use the same context semantics;
8. Phase 3B translation usage remains source-character based and idempotent;
9. Studio exposes clear glossary/style/capability/conflict UX;
10. exact-head PR CI and post-merge main CI are green;
11. production runtime status remains explicitly UNQUALIFIED until separate live deployment gates pass.
