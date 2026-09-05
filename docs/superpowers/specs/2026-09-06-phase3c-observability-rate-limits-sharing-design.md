# DubFlow Phase 3C — Observability, Rate Limits, and Revocable Sharing

Date: 2026-09-06
Status: Design approved in chat; written spec pending user review
Base commit: `caee266d01c8dc8194e9d3abf57dc6908dfd92c6`
Branch: `feat/phase3c-observability-rate-limits-sharing`

## 1. Goal

Phase 3C hardens the SaaS layer with three related safety boundaries:

1. production-grade observability for requests, providers, rate-limit decisions, shares, and downloads;
2. Cloudflare-native rate limiting for expensive operations before job creation or provider calls;
3. revocable, expiring, read-only export sharing without requiring the recipient to authenticate.

This phase intentionally absorbs the previously deferred share/download-controls work. A separate Phase 3D sharing subsystem is unnecessary unless later requirements add collaborators, permission matrices, public discovery, or another materially broader sharing model.

Phase 3B `usage_events` remains the accounting source of truth. Phase 3C telemetry is operational analytics only and must never replace usage accounting, credit state, or future billing/quota enforcement.

## 2. Current foundation

Live `main` at the design base already provides:

- Hono API routes with server-derived current-user identity;
- D1 projects/jobs/usage repositories;
- R2-backed owner export media streaming with byte-range support;
- durable dubbing/export workflows;
- the idempotent Phase 3B usage ledger plus unit-collision guard;
- `wrangler.jsonc` with basic Workers observability enabled;
- no dedicated Rate Limiting binding, Analytics Engine binding, or share-token subsystem.

Phase 3C must preserve Phase 3A/3B behavior and existing owner authorization.

## 3. Architectural decision

Use Cloudflare-native platform primitives rather than D1 hot counters or a new Durable Object admission subsystem.

### 3.1 Rate limiting

Use Workers Rate Limiting bindings. Rate limiting is abuse/admission control only. The platform API is local, permissive, and eventually consistent, so it must not be treated as exact accounting, billing, or quota enforcement.

Each expensive operation class gets its own binding and namespace. Initial 60-second policies:

| Operation class | Initial limit | Applies to |
| --- | ---: | --- |
| `process` | 4/minute/user | start full dubbing |
| `export` | 4/minute/user | start final export |
| `translate` | 30/minute/user | segment retranslation |
| `voice` | 30/minute/user | voice preview now; future regenerate route when it exists |
| `upload` | 20/minute/user | upload-session creation |

The five namespace IDs must be distinct. Implementation reserves one contiguous DubFlow-only numeric namespace range in `wrangler.jsonc` and acceptance-tests uniqueness.

The limiter key is the authenticated opaque user ID plus operation class, for example `dev-user:process`. Do not rate-limit by IP address.

For project-scoped routes, order is:

1. derive user identity server-side;
2. validate project/resource ownership and request shape;
3. call the relevant rate limiter;
4. on rejection, emit telemetry and return 429;
5. only then create a job, invoke a provider, create an upload session, or start a Workflow.

This order avoids cross-user existence leaks, prevents invalid requests from consuming limiter budget, and guarantees a rejected request does not create billable work.

A rate-limited response is:

- HTTP `429`;
- code `RATE_LIMITED`;
- generic operation-scoped message with no internal counter details;
- `Retry-After: 60`.

A 429 must not:

- create a job;
- call AI, translation, TTS, media, Workflow, or upload-provider work;
- write a Phase 3B usage event;
- mutate `credit_balance`;
- change project state.

Media byte-range playback/download is not an expensive AI action and is not covered by these five bindings in Phase 3C.

### 3.2 Observability

Use three complementary layers:

1. Workers Logs for searchable invocation/custom/error logs;
2. Workers Traces for sampled traces;
3. Workers Analytics Engine for structured high-cardinality operational events.

`wrangler.jsonc` will explicitly configure:

- logs enabled with head sampling `1.0`;
- invocation logs enabled;
- `redact_query_string: true` for logs/traces so bearer share secrets in query strings are not persisted in platform request URLs;
- traces enabled with head sampling `0.05`;
- Analytics Engine binding `ANALYTICS` to dataset `dubflow_events`.

No external observability vendor is introduced in Phase 3C.

### 3.3 Sharing

Owner download remains project-owner authorized exactly as today.

A new share subsystem creates revocable, expiring, read-only links to one concrete export artifact. Anonymous access is permitted only with a valid bearer secret.

Each share has:

- opaque non-secret `shareId`;
- random 256-bit secret;
- SHA-256 hash of that secret stored in D1;
- short non-secret token hint;
- project binding;
- exact export object-key binding;
- expiration timestamp;
- optional revocation timestamp.

Plaintext share secrets are returned once at creation and are never persisted server-side.

The public URL uses a non-secret path plus a query-string bearer secret:

`GET /api/shares/:shareId/media?token=<secret>`

This shape is deliberate. Cloudflare invocation logs include request URLs, while the platform supports query-string redaction for logs/traces. Putting the secret directly in the path would make reliable platform-level redaction impossible.

The share URL is a bearer credential. Anyone possessing it can download the bound export until expiration/revocation. The media response adds `Referrer-Policy: no-referrer` and does not embed third-party resources.

Because plaintext is not stored, an existing share URL cannot be reconstructed from D1 after its creation response is lost. The UI guarantees `Copy link` immediately after creation. After reload, stored shares show metadata/status/revoke controls; if the owner no longer has the secret, they create a replacement share.

Default expiration is 7 days. The API accepts optional TTL from 1 hour through 30 days. Values outside that range are rejected rather than silently clamped.

A share never grants permission to:

- edit project/segment data;
- read private project metadata beyond media delivery needs;
- start processing or export;
- retranslate;
- preview/regenerate voice;
- list jobs, speakers, segments, usage, or other shares.

## 4. Components

### 4.1 `worker/src/security/rate-limit.ts`

Owns operation-class typing, limiter selection, key construction, `Retry-After`, and one allow/reject helper.

Consumers must not call Cloudflare rate-limit bindings directly except through this helper. The helper is dependency-injectable for deterministic tests.

### 4.2 `worker/src/observability/telemetry.ts`

Defines a small `TelemetrySink` interface and production Analytics Engine / structured-log implementation.

Canonical events:

- `request_completed`;
- `provider_success`;
- `provider_failure`;
- `rate_limited`;
- `share_access`;
- `export_download`.

Events use normalized fields only. No custom event may include transcript/source/translated text, media bytes, voice text, API keys, authorization headers, cookies, raw share secrets/hashes, raw query strings, or arbitrary exception bodies.

Correlation fields where available:

- `requestId`;
- opaque `userId` or anonymous actor marker;
- `projectId`;
- `jobId`;
- `shareId`;
- operation class;
- provider;
- normalized status/error code;
- HTTP status;
- duration milliseconds.

Phase 3B usage units and `cost_basis` are deliberately excluded from Analytics Engine's accounting contract. Operational telemetry may state that a provider call occurred, but it never becomes the billing ledger.

Analytics Engine and structured-log failures are non-fatal. Telemetry failure cannot change business-operation success/failure.

### 4.3 Request correlation middleware

Add Hono middleware for `/api/*` that generates a server request ID with `crypto.randomUUID()` and returns it in `x-request-id`.

The middleware records request duration and emits one normalized `request_completed` event after the matched request returns.

Custom telemetry uses route templates/operation names, never raw URL/query strings. The share-media route records `/api/shares/:shareId/media`, not its `token` query value.

### 4.4 Provider instrumentation

Instrument provider boundaries used by expensive routes/workflows so success/failure events carry provider, operation, request/job/project correlation, normalized error code, and latency.

Do not log provider response bodies or raw thrown messages that might contain user/provider content.

Provider telemetry preserves existing error behavior and does not alter Phase 3B usage-event idempotency or canonical units.

### 4.5 D1 share repository

Add migration `migrations/0006_export_shares.sql` and repository `worker/src/db/shares.ts`.

Canonical table:

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

Add index `(project_id, created_at DESC)`. `token_hash` uniqueness provides its lookup index.

`token_hint` is display-only and cannot authenticate.

Repository responsibilities:

- create after owner authorization;
- list owner/project shares without plaintext/hash exposure;
- revoke idempotently;
- resolve by `shareId` + secret hash only when unexpired/unrevoked;
- never write `last_accessed_at`; access counts belong in telemetry, avoiding a D1 write per download.

Secret verification uses Web Crypto SHA-256 and exact hash comparison/lookup. Plaintext secrets are never logged.

### 4.6 Shared media streaming helper

Extract existing export Range handling into one reusable helper used by both:

- owner `GET /api/projects/:id/export/media`;
- anonymous `GET /api/shares/:shareId/media?token=<secret>`.

The helper owns:

- R2 `head` only when needed to validate Range;
- Range parsing;
- `206` partial responses;
- `416` invalid-range responses with `Content-Range: bytes */<size>`;
- `Accept-Ranges: bytes`;
- content type, length, ETag, and attachment filename.

Authorization/token validation happens before the helper. The helper knows nothing about users or secrets.

## 5. API contract

### 5.1 Create share

`POST /api/projects/:id/shares`

Request:

```json
{ "expiresInSeconds": 604800 }
```

`expiresInSeconds` is optional; default 604800 seconds. Valid range: 3600 through 2592000 seconds.

Preconditions:

- project belongs to server-derived current user;
- project has a completed export object key.

Success `201` returns metadata plus the one-time share URL:

```json
{
  "share": {
    "id": "share-id",
    "projectId": "project-id",
    "status": "active",
    "expiresAt": "...",
    "createdAt": "...",
    "tokenHint": "..."
  },
  "shareUrl": "https://yupvox.qs3d.site/api/shares/share-id/media?token=<secret>"
}
```

The URL is constructed without storing plaintext in D1.

### 5.2 List shares

`GET /api/projects/:id/shares`

Owner-authorized only. Returns metadata, never token hashes, plaintext secrets, or reconstructable URLs.

Computed statuses: `active`, `expired`, `revoked`.

### 5.3 Revoke

`DELETE /api/projects/:id/shares/:shareId`

Owner-only. Revocation is idempotent. Cross-user access is hidden as `404`.

### 5.4 Anonymous shared media

`GET /api/shares/:shareId/media?token=<secret>`

No login required.

Resolution:

1. validate non-empty secret and hash it;
2. resolve exact `shareId` + hash;
3. reject unknown/expired/revoked/mismatched credentials as generic `404 SHARE_NOT_FOUND`;
4. stream the bound `export_object_key` through the shared media helper;
5. emit `share_access` using `shareId`, never secret/hash;
6. preserve owner-equivalent Range semantics;
7. add `Referrer-Policy: no-referrer`.

Expired, revoked, mismatched, and unknown shares intentionally return the same 404 shape.

## 6. UI

Add a compact sharing surface in the existing export area/dashboard, not a new collaboration product.

Owner capabilities:

- create share link;
- choose expiry within allowed range;
- copy newly created link;
- list active/expired/revoked shares;
- revoke active share.

After reload, a share whose plaintext secret is unavailable displays metadata and revoke controls but no reconstructable link. The UI explains that a replacement share can be created.

No Phase 3C UI for social/public discovery, collaborators, per-recipient ACLs, comments, share analytics dashboards, payment, or upgrades.

## 7. Rate-limit route coverage

### `process`

Apply to `POST /api/projects/:id/process` after project/source validation and before `jobs.create()` / Workflow create.

### `export`

Apply to `POST /api/projects/:id/export` after project/exportability/provider-config validation and before `jobs.create()` / Workflow create.

### `translate`

Apply to `POST /api/projects/:id/segments/:segmentId/retranslate` after owner/segment/version/mode validation and before provider translation.

### `voice`

Apply to current `POST /api/voice/preview` after body/language/provider-config validation and before ElevenLabs generation. When a real regenerate-voice endpoint exists, it must reuse the same operation class. Phase 3C does not create a regeneration feature solely for rate limiting.

### `upload`

Apply to upload-session creation after project ownership and upload-request validation but before R2 multipart-session creation.

## 8. Telemetry behavior

### `rate_limited`

Emit operation class, request ID, opaque actor, authorized project ID when available, and HTTP 429. Never emit attempted prompt/text/media metadata.

### `provider_success` / `provider_failure`

Emit provider, operation, request/job/project IDs, normalized outcome/error code, and latency. Never emit provider response bodies or raw errors.

### `share_access`

Emit share ID, project ID, request ID, HTTP status, Range/non-Range indicator, and latency. Never emit secret/hash/query string.

### `export_download`

Emit for owner export downloads and successful shared downloads with access mode `owner` or `share`.

### `request_completed`

Emit normalized route template, method, status, duration, request ID, and actor class. Never use raw URL/query string.

## 9. Error handling and security

- authorization precedes project-scoped rate limiting;
- rate-limit rejection precedes expensive work;
- anonymous share lookup reveals no distinction among unknown/expired/revoked/mismatched credentials;
- owner share list never returns token hashes;
- plaintext secrets are returned once only;
- share secrets use at least 256 bits CSPRNG entropy;
- Web Crypto generates secret bytes and SHA-256 hashes;
- custom telemetry never contains share secrets/hashes;
- Workers observability enables `redact_query_string: true` because share secrets are query bearer credentials;
- no transcript/source/translation/voice text or provider secrets in telemetry;
- Range parsing remains fail-closed and shared with owner path;
- share creation snapshots the current export object key, so later re-export does not retarget old links;
- share DELETE is soft revocation, preserving owner-visible history;
- telemetry never mutates Phase 3B usage ledger or credits;
- share URLs are bearer credentials and must be treated as secrets by UI/documentation.

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
- response has `Retry-After: 60` and `RATE_LIMITED`.

### 10.2 Telemetry tests

- request IDs are generated and returned;
- normalized events include required correlation fields;
- raw share secrets/hashes/query strings are absent;
- authorization/API keys and transcript/voice/translation text are absent;
- provider raw errors/bodies are normalized/redacted;
- Analytics Engine failure does not fail request;
- telemetry-only operations do not alter `usage_events`.

### 10.3 Share repository/API tests

- plaintext secret is not stored;
- SHA-256 secret resolution succeeds with matching `shareId`;
- list never returns hash/plaintext/reconstructable URL;
- default and requested expiry;
- invalid TTL rejected;
- expired/revoked/mismatched/unknown credentials all fail closed;
- revocation idempotent;
- cross-user create/list/revoke hidden as 404;
- share binds current export object key;
- later export does not retarget old share.

### 10.4 Media tests

Run owner and share routes through the same helper and verify:

- full `200`;
- valid `206`;
- invalid `416`;
- `Accept-Ranges`, `Content-Range`, `Content-Length`, content type, ETag, disposition;
- shared response has `Referrer-Policy: no-referrer`;
- share media cannot reach private project metadata or mutation routes.

### 10.5 UI tests

- create + one-time copy link;
- active/expired/revoked rendering;
- revoke;
- no plaintext reconstruction after reload;
- no payment/collaborator/public-discovery UI introduced.

### 10.6 Acceptance gate

Add `tests/phase3c-safety-sharing-acceptance.test.mjs` to the normal `npm run verify` path. It locks:

- five distinct rate-limit bindings and configured policies;
- Analytics Engine binding;
- explicit logs/traces config, query-string redaction, and 5% trace sampling;
- hash-only share persistence;
- non-secret share ID in path and redacted bearer secret in query;
- owner/share shared Range helper;
- 429-before-expensive-work contract;
- telemetry redaction constraints;
- source/CI qualification language without production-runtime claims.

## 11. Qualification and merge workflow

1. branch from exact live `main`;
2. write implementation plan after written-spec approval;
3. TDD each component;
4. exact-head push CI;
5. if live `main` advanced, reconcile non-force and rerun exact-head CI;
6. open feature PR;
7. exact-head PR CI GREEN;
8. race-check `main` and PR head;
9. merge with expected-head SHA;
10. post-merge `main` CI GREEN.

No force push and no blind ours/theirs conflict resolution.

## 12. Production-runtime boundary

Phase 3C may become source/CI-qualified and merged while production remains explicitly UNQUALIFIED.

Do not perform or claim production deployment/qualification until the existing Cloudflare Container credential blocker and live provider/media fixture gates are separately resolved.

Analytics Engine, Rate Limiting bindings, logs/traces, and share behavior require later real Cloudflare deployment/runtime qualification before they can be called production-qualified.

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
- collaborators/ACL matrices;
- comments;
- password-protected shares;
- per-recipient identity;
- new voice-regeneration product behavior;
- production deployment while external runtime gates remain blocked.

## 14. Success criteria

Phase 3C is complete at the repository/CI layer when:

1. expensive operations are user/action rate-limited before expensive work;
2. 429 is observable and has no accounting/business-state side effects;
3. Workers Logs, sampled traces, query redaction, and Analytics Engine have explicit source contracts;
4. operational telemetry is correlated and redacted;
5. owners can create, list, and revoke expiring export shares;
6. anonymous recipients can download only the bound export with matching `shareId` + bearer secret;
7. revoked/expired/mismatched/unknown credentials fail closed identically;
8. owner/share downloads share one tested Range implementation;
9. Phase 3B usage accounting remains canonical and unchanged;
10. exact-head push CI, PR CI, and post-merge main CI are GREEN;
11. production runtime remains explicitly unqualified until separate gates pass.
