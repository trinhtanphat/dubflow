# DubFlow Phase 3C — Observability, Rate Limits, and Revocable Sharing

Date: 2026-09-06
Status: Design approved in chat; implementation blocked on written-spec review
Base commit: `caee266d01c8dc8194e9d3abf57dc6908dfd92c6`
Branch: `feat/phase3c-observability-rate-limits-sharing`

## 1. Goal

Phase 3C hardens the SaaS layer with three tightly related safety boundaries:

1. production-grade observability for requests, providers, rate-limit decisions, shares, and downloads;
2. Cloudflare-native rate limiting for expensive operations before job creation or provider calls;
3. revocable, expiring, read-only export sharing without requiring the recipient to authenticate.

This phase intentionally absorbs the previously deferred share/download controls work. A separate Phase 3D share subsystem is no longer required unless later product requirements introduce collaborators, permissions matrices, public discovery, or other materially broader sharing features.

Phase 3B `usage_events` remains the accounting source of truth. Phase 3C telemetry is operational analytics only and must never replace usage accounting, credit state, or future billing/quota enforcement.

## 2. Current foundation

Live `main` already provides:

- Hono API routes with server-derived current-user identity;
- D1 projects/jobs/usage repositories;
- R2-backed owner export media streaming with byte-range support;
- durable dubbing/export workflows;
- an idempotent Phase 3B usage ledger;
- `wrangler.jsonc` with Workers observability enabled;
- no dedicated rate-limit binding, Analytics Engine binding, or share-token subsystem.

Phase 3C must preserve all Phase 3A/3B behavior and existing owner authorization.

## 3. Architectural decision

Use Cloudflare-native platform primitives rather than introducing D1 hot counters or a new Durable Object admission subsystem.

### 3.1 Rate limiting

Use Workers Rate Limiting bindings. Rate limiting is an abuse/admission control only. It is permissive and eventually consistent, so it must not be treated as exact accounting, billing, or quota enforcement.

Each expensive operation class gets its own binding and namespace. The initial 60-second limits are:

| Operation class | Initial limit | Applies to |
| --- | ---: | --- |
| `process` | 4/minute/user | start full dubbing |
| `export` | 4/minute/user | start final export |
| `translate` | 30/minute/user | segment retranslation |
| `voice` | 30/minute/user | voice preview now; future regenerate route when it exists |
| `upload` | 20/minute/user | upload-session creation |

The binding namespaces must be distinct. Implementation will reserve one contiguous DubFlow-only numeric namespace range in `wrangler.jsonc` and acceptance-test that all configured IDs are distinct.

The limiter key is the authenticated opaque user ID plus operation class, for example `dev-user:process`. Do not rate-limit by IP address.

For project-scoped routes, order is:

1. derive user identity server-side;
2. validate project/resource ownership and request shape;
3. call the relevant rate limiter;
4. if rejected, emit telemetry and return 429;
5. only then create a job, invoke a provider, create an upload session, or start a Workflow.

This ordering avoids leaking cross-user resource existence, prevents invalid requests from consuming the caller's limiter budget, and guarantees a rejected request does not create billable work.

A rate-limited response is:

- status `429`;
- code `RATE_LIMITED`;
- a generic message that identifies the operation class but not internal counters;
- `Retry-After: 60`.

A 429 must not:

- create a job;
- call AI, translation, TTS, media, Workflow, or upload-provider work;
- write a Phase 3B usage event;
- mutate `credit_balance`;
- change project state.

Media byte-range playback/download is not classified as an expensive AI operation and is not covered by these five expensive-operation bindings in Phase 3C.

### 3.2 Observability

Use three complementary layers:

1. Workers Logs for searchable invocation/custom/error logs;
2. Workers Traces for sampled distributed/request traces;
3. Workers Analytics Engine for structured high-cardinality operational events.

`wrangler.jsonc` will explicitly configure:

- logs enabled with initial head sampling `1.0`;
- traces enabled with head sampling `0.05`;
- Analytics Engine binding `ANALYTICS` to dataset `dubflow_events`.

The source design assumes no external observability vendor in Phase 3C.

### 3.3 Sharing

Owner download remains authorized by project ownership exactly as today.

A new share subsystem creates revocable, expiring, read-only links to one concrete export artifact. Anonymous access is permitted only with a valid unguessable token.

The share token is a random 256-bit secret. Only its SHA-256 hash is stored in D1. Plaintext is returned once when a share is created and is never persisted server-side.

A share binds to:

- the project;
- the exact export object key that existed at creation time;
- an expiration timestamp;
- optional revocation timestamp.

Because the plaintext token is not stored, an existing share URL cannot be reconstructed from D1 after the creation response is lost. The UI guarantees `Copy link` immediately after creation. After reload, existing shares show status and can be revoked; if the owner no longer has the secret, they create a replacement share instead of recovering plaintext.

Default expiration is 7 days. The API may accept a requested TTL from 1 hour through 30 days; values outside that range are rejected rather than silently clamped.

A share never grants permission to:

- edit project or segment data;
- read private project metadata beyond what is needed to stream the export;
- start processing or export;
- retranslate;
- preview/regenerate voice;
- list jobs, speakers, segments, usage, or other shares.

## 4. Components

### 4.1 `worker/src/security/rate-limit.ts`

Owns operation-class typing, limiter selection, key construction, `Retry-After`, and a single helper that returns an allow/reject decision.

Consumers must not call Cloudflare bindings directly from route code except through this helper.

The helper is dependency-injectable so route tests can use deterministic in-memory fakes.

### 4.2 `worker/src/observability/telemetry.ts`

Defines a small `TelemetrySink` interface and the production Analytics Engine / structured-log implementation.

Canonical event names:

- `request_completed`;
- `provider_success`;
- `provider_failure`;
- `rate_limited`;
- `share_access`;
- `export_download`.

Events use normalized fields only. No event may include transcript/source/translated text, media bytes, voice text, API keys, authorization headers, cookies, raw share tokens, raw query strings, or arbitrary exception bodies.

Canonical correlation fields where available:

- `requestId`;
- opaque `userId` or anonymous actor marker;
- `projectId`;
- `jobId`;
- `shareId`;
- operation class;
- provider;
- normalized status/error code;
- HTTP status;
- duration in milliseconds.

Phase 3B usage units and `cost_basis` are deliberately excluded from Analytics Engine's accounting contract. Operational events may indicate that a provider call occurred but do not become the billing ledger.

### 4.3 Request correlation middleware

Add Hono middleware for `/api/*` that generates a new server request ID with `crypto.randomUUID()` and returns it in `x-request-id`.

The middleware records start time and emits one normalized `request_completed` event after the matched request returns.

Telemetry must use route templates / operation names, never a raw URL. In particular, `/api/shares/:token/media` must never cause the plaintext share token to be copied into custom logs or Analytics Engine.

### 4.4 Provider instrumentation

Instrument provider boundaries used by expensive routes/workflows so success/failure events carry provider, operation, request/job/project correlation, and latency.

Provider telemetry must preserve existing provider error behavior. Telemetry failure itself must not fail the business operation.

Phase 3C does not change Phase 3B usage-event idempotency or unit semantics.

### 4.5 D1 share repository

Add migration `migrations/0006_export_shares.sql` and repository `worker/src/db/shares.ts`.

Canonical table shape:

```sql
CREATE TABLE export_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  export_object_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Indexes:

- `(project_id, created_at DESC)` for owner listing;
- `(token_hash)` is covered by the unique constraint/index.

`token_hint` is a short non-secret display suffix/prefix and must never be sufficient to authenticate.

Repository responsibilities:

- create a share only after owner authorization is already established;
- list shares for an owner/project without plaintext tokens;
- revoke one share idempotently;
- resolve a token hash only when not revoked and not expired;
- never update `last_accessed_at` in D1; access counts belong in telemetry, avoiding a write on every download.

Token verification hashes the presented secret with Web Crypto SHA-256 and performs exact hash lookup. Plaintext tokens are never logged.

### 4.6 Shared media streaming helper

Extract the existing export Range handling into one reusable helper used by both:

- owner route `GET /api/projects/:id/export/media`;
- anonymous share route `GET /api/shares/:token/media`.

The helper owns:

- R2 `head` only when required for validating a Range request;
- `Range` parsing;
- `206` partial responses;
- `416` invalid-range responses with `Content-Range: bytes */<size>`;
- `Accept-Ranges: bytes`;
- content type, length, ETag, and attachment filename.

Authorization/token validation happens before the helper is called. The helper does not know about users or tokens.

## 5. API contract

### 5.1 Owner share management

`POST /api/projects/:id/shares`

Request:

```json
{ "expiresInSeconds": 604800 }
```

`expiresInSeconds` is optional. Default is 604800 seconds (7 days). Valid range is 3600 through 2592000 seconds.

Preconditions:

- project belongs to current server-derived user;
- project has a completed export object key.

Success `201` returns the share record plus the one-time plaintext URL/token:

```json
{
  "share": {
    "id": "...",
    "projectId": "...",
    "status": "active",
    "expiresAt": "...",
    "createdAt": "...",
    "tokenHint": "..."
  },
  "shareUrl": "https://yupvox.qs3d.site/api/shares/<token>/media"
}
```

The public URL is constructed from the request origin / canonical production origin policy without storing plaintext in D1.

### 5.2 Owner share list

`GET /api/projects/:id/shares`

Returns owner-authorized share metadata only. It never returns token hashes or plaintext URLs.

Computed statuses:

- `active`;
- `expired`;
- `revoked`.

### 5.3 Revoke

`DELETE /api/projects/:id/shares/:shareId`

Owner-only. Revocation is idempotent: an already revoked share returns success with revoked state. Cross-user access remains hidden as `404`.

### 5.4 Anonymous shared media

`GET /api/shares/:token/media`

No login required.

Resolution sequence:

1. hash token;
2. find active, unexpired, unrevoked share;
3. if absent, return generic `404 SHARE_NOT_FOUND`;
4. stream its bound `export_object_key` through the shared media helper;
5. emit `share_access` without the token;
6. preserve Range semantics identical to owner media.

Expired and revoked shares intentionally return the same 404 shape as unknown tokens.

## 6. UI

Add a compact sharing surface in the existing export area/dashboard rather than a new collaboration product.

Owner capabilities:

- create share link;
- choose expiry within the allowed range;
- copy the newly created link;
- list active/expired/revoked shares;
- revoke an active share.

After reload, a stored share whose plaintext token is unavailable displays metadata and revoke controls but not a reconstructable link. The UI explains that a replacement link can be created.

No Phase 3C UI for:

- social/public discovery;
- collaborators;
- per-recipient ACLs;
- comments;
- share analytics dashboards;
- payments/upgrades.

## 7. Rate-limit route coverage

### `process`

Apply to `POST /api/projects/:id/process` after project/source validation and before `jobs.create()` / Workflow create.

### `export`

Apply to `POST /api/projects/:id/export` after project/exportability/provider-config validation and before `jobs.create()` / Workflow create.

### `translate`

Apply to `POST /api/projects/:id/segments/:segmentId/retranslate` after owner/segment/version/mode validation and before provider translation.

### `voice`

Apply immediately to the current `POST /api/voice/preview` after body/language/provider-configuration validation and before ElevenLabs generation. When a real regenerate-voice endpoint exists, it must use the same operation class. Phase 3C does not create a new regeneration feature solely for rate limiting.

### `upload`

Apply to upload-session creation after project ownership and upload request validation but before provider/R2 multipart session creation.

## 8. Telemetry behavior

### `rate_limited`

Emit operation class, request ID, opaque actor, project ID when already authorized, and HTTP 429. Never emit attempted prompt/text/media metadata.

### `provider_success` / `provider_failure`

Emit provider, operation, request/job/project IDs, normalized outcome/error code, and latency. Do not emit provider response bodies or thrown raw messages that may contain upstream content.

### `share_access`

Emit share ID, project ID, request ID, HTTP status, byte-range/non-range indicator, and latency. Never emit token/token hash.

### `export_download`

Emit for owner export downloads and may also be emitted for successful shared media downloads with an access mode field (`owner` or `share`).

### `request_completed`

Emit normalized route template, method, status, duration, request ID, and actor class. Do not use raw URL/query strings.

Telemetry write errors are swallowed after a sanitized `console.error` marker; they cannot change API success/failure behavior.

## 9. Error handling and security

- authorization precedes project-scoped rate limiting;
- rate-limit rejection precedes expensive work;
- anonymous share lookup reveals no difference between unknown, expired, and revoked tokens;
- owner share list never returns token hashes;
- plaintext tokens are returned once only;
- share tokens are at least 256 bits of CSPRNG entropy;
- use Web Crypto for random bytes and SHA-256;
- no tokens in structured logs/Analytics Engine;
- no transcript/source text or provider secrets in telemetry;
- Range parsing remains fail-closed and shared with the owner path;
- share creation binds the current export object key so a later re-export does not silently change what an existing link serves;
- share deletion is soft revocation, not row deletion, preserving owner-visible history and audit semantics;
- telemetry does not mutate Phase 3B usage ledger or credits.

## 10. Testing strategy

Implementation follows TDD.

### 10.1 Rate-limit tests

- allowed request reaches expensive boundary;
- same user/action burst crosses threshold and returns 429;
- different users do not share budget;
- different operation classes do not share budget;
- invalid request does not consume budget;
- unauthorized project request returns 404 and does not consume budget;
- 429 occurs before `jobs.create`, Workflow create, R2 upload-session creation, or provider call;
- 429 writes no usage event and mutates no credits/project state;
- response contains `Retry-After: 60` and `RATE_LIMITED`.

### 10.2 Telemetry tests

- request IDs are generated and returned;
- normalized events include required correlation fields;
- raw share tokens are absent;
- authorization/API keys and transcript/voice/translation text are absent;
- provider raw errors/bodies are redacted to normalized codes;
- Analytics Engine failure does not fail the request;
- `usage_events` remains untouched by telemetry-only operations.

### 10.3 Share repository/API tests

- token plaintext is not stored;
- SHA-256 token resolution succeeds;
- list never returns hash/plaintext;
- default and requested expiry behavior;
- invalid TTL rejected;
- expired/revoked/unknown tokens all fail closed;
- revocation idempotent;
- cross-user create/list/revoke hidden as 404;
- share binds the current export object key;
- creating a later export does not retarget old share.

### 10.4 Media tests

Run owner and share routes through the same helper and verify:

- full `200`;
- valid `206`;
- invalid `416`;
- `Accept-Ranges`, `Content-Range`, `Content-Length`, content type, ETag, and disposition behavior;
- share media cannot reach project metadata or mutation routes.

### 10.5 UI tests

- create + one-time copy link;
- active/expired/revoked status rendering;
- revoke;
- no reconstruction of plaintext after reload;
- no payment, collaborator, or public-discovery UI introduced.

### 10.6 Acceptance gate

Add `tests/phase3c-safety-sharing-acceptance.test.mjs` to the normal `npm run verify` path. It locks:

- five distinct rate-limit bindings and configured policies;
- Analytics Engine binding;
- logs/traces config and 5% trace sampling;
- token hash-only persistence;
- owner/share shared Range helper;
- 429-before-expensive-work contract;
- telemetry redaction constraints;
- source/CI qualification language without production-runtime claims.

## 11. Qualification and merge workflow

1. branch from exact live `main`;
2. write implementation plan after written-spec approval;
3. TDD each component;
4. run exact-head push CI;
5. if live `main` advanced, reconcile non-force and rerun exact-head CI;
6. open feature PR;
7. require exact-head PR CI GREEN;
8. race-check `main` and PR head;
9. merge with expected-head SHA;
10. require post-merge `main` CI GREEN.

No force push and no blind ours/theirs conflict resolution.

## 12. Production-runtime boundary

Phase 3C may become source/CI-qualified and merged while production remains explicitly UNQUALIFIED.

Do not perform or claim production deployment/qualification until the existing Cloudflare Container credential blocker and live provider/media fixture gates are separately resolved.

Analytics Engine, Rate Limiting bindings, logs/traces, and share behavior all require a later real Cloudflare deployment/runtime qualification before they can be called production-qualified.

## 13. Non-goals

Phase 3C does not add:

- payment processing;
- credit debit/reservation;
- exact monthly quotas;
- billing enforcement;
- admin analytics dashboards;
- D1 rate counters;
- Durable Object rate counters;
- social/public project discovery;
- collaborators or ACL matrices;
- comments;
- password-protected shares;
- per-recipient identity;
- new voice-regeneration product behavior;
- production deployment while external runtime gates remain blocked.

## 14. Success criteria

Phase 3C is complete at the repository/CI layer when:

1. expensive operations are user/action rate-limited before expensive work;
2. rate-limit rejection is observable and has no billing/accounting side effects;
3. Workers Logs, sampled traces, and Analytics Engine have explicit source contracts;
4. operational telemetry is correlated and redacted;
5. owners can create, list, and revoke expiring export shares;
6. anonymous recipients can download only the bound export with a valid token;
7. revoked/expired/unknown tokens fail closed identically;
8. owner and share downloads share one tested Range implementation;
9. Phase 3B usage accounting remains canonical and unchanged;
10. exact-head push CI, PR CI, and post-merge main CI are GREEN;
11. production runtime remains explicitly unqualified until its separate gates pass.
