# Agent Coordination Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub-native reservation and ownership protocol that prevents duplicate agent carriers, audits changed-file scope, and warns about overlapping work without introducing any paid service.

**Architecture:** Keep human-readable policy in root/docs/PR template and put deterministic validation in one dependency-free Node module. The existing CI workflow invokes the validator only for pull requests, while `verify:deploy-config` runs unit tests for the pure parser/comparison logic on every source verification run.

**Tech Stack:** Markdown, GitHub pull requests, GitHub Actions, Node.js 22 ESM, built-in `node:test`, built-in `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-07-agent-coordination-design.md`

## Global Constraints

- GitHub remains the coordination system of record.
- No paid service, paid API, AI Gateway top-up, Cloudflare Container, Cloudflare Stream, or other new paid coordination dependency.
- Never force-update an integration carrier to bypass another agent.
- Never bypass RED CI or merge an exact-head RED PR.
- One logical feature/issue lane has one active primary carrier PR.
- Path overlap between different lanes is warning-only in version 1.
- Existing in-flight PRs without the coordination block remain legacy-compatible.
- Do not modify YupVox runtime, voice/Piper implementation, or production media qualification code in this carrier.

---

### Task 1: Lock the coordination contract with RED tests

**Files:**
- Create: `tests/agent-coordination.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Node's built-in `node:test` and `node:assert/strict`.
- Produces expected exports from `scripts/agent-coordination.mjs`: `parseCoordinationBlock(body)`, `normalizeReservation(value)`, `reservationCovers(reservation, path)`, `findReservationOverlaps(current, other)`, `validateCoordination({ currentPr, openPrs, changedFiles })`, and `isExemptActor(login)`.

- [ ] **Step 1: Write failing tests**

Create tests for:

```js
import {
  findReservationOverlaps,
  isExemptActor,
  normalizeReservation,
  parseCoordinationBlock,
  reservationCovers,
  validateCoordination,
} from '../scripts/agent-coordination.mjs';
```

The suite must assert:

- a valid coordination block parses the exact lane, carrier, base SHA, paid-resource setting, and reservations;
- invalid reservation syntax such as `../worker/**`, `/worker/**`, and `src/*/voice/**` is rejected;
- exact and `/**` directory reservations cover only intended files;
- same lane key in another policy-aware open PR is a validation error;
- a changed file outside reservations is a validation error;
- different-lane overlapping reservations are returned as warnings, not errors;
- `dependabot[bot]`, `renovate[bot]`, and `github-actions[bot]` are exempt while a normal user is not.

- [ ] **Step 2: Wire the test into source verification**

Append `tests/agent-coordination.test.mjs` to the `verify:deploy-config` command in `package.json` so the repository's existing `npm run verify` executes it.

- [ ] **Step 3: Verify RED**

Run via fresh CI on the policy branch/PR. Expected failure: Node cannot import `../scripts/agent-coordination.mjs` because the implementation does not exist yet.

- [ ] **Step 4: Commit the RED contract**

Commit only the test and verification wiring before adding production policy implementation.

---

### Task 2: Implement deterministic coordination validation

**Files:**
- Create: `scripts/agent-coordination.mjs`

**Interfaces:**
- `parseCoordinationBlock(body: string) -> Coordination | null`
- `normalizeReservation(value: string) -> { raw: string, kind: 'file'|'dir', prefix: string }`
- `reservationCovers(reservation, path: string) -> boolean`
- `findReservationOverlaps(current: Coordination, other: Coordination) -> Array<{ current: string, other: string }>`
- `validateCoordination({ currentPr, openPrs, changedFiles }) -> { errors: string[], warnings: string[] }`
- `isExemptActor(login: string) -> boolean`
- CLI reads `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, and `GITHUB_TOKEN`.

- [ ] **Step 1: Implement strict metadata parsing**

Require `Lane-Key`, `Carrier`, `Issue`, `Base-SHA`, `Depends-On`, `Handoff-From`, `Paid-Resources`, and at least one `Reserved-Paths` item. Accept only `Carrier: primary`, kebab-case lane keys, 40-hex base SHA, and `Paid-Resources: FORBIDDEN`.

- [ ] **Step 2: Implement reservation normalization and coverage**

Reject leading slash, parent traversal, empty values, backslashes, and wildcards except one trailing `/**`. Normalize leading `./` away and use `/` separators.

- [ ] **Step 3: Implement validation**

For a normal actor:

```text
missing/invalid block -> error
duplicate Lane-Key among policy-aware open PRs -> error
changed file outside Reserved-Paths -> error
different-lane reservation overlap -> warning
```

Ignore legacy open PRs whose bodies do not parse as policy-aware coordination blocks.

- [ ] **Step 4: Implement GitHub Actions CLI**

On `pull_request` events, read the current PR from event JSON, retrieve all open PRs and current changed files with authenticated GitHub REST requests, validate, emit `::error::`/`::warning::`, and exit non-zero only when errors exist. On non-PR events, print a skip message and exit zero.

- [ ] **Step 5: Verify GREEN for the focused tests**

Run `node --test tests/agent-coordination.test.mjs`. Expected: all tests PASS.

---

### Task 3: Publish repository-wide agent policy

**Files:**
- Create: `AGENTS.md`
- Create: `docs/AGENT-COORDINATION.md`
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Consumes the metadata contract implemented by Task 2.
- Produces the mandatory discovery and handoff protocol used by future agents.

- [ ] **Step 1: Add root `AGENTS.md`**

State the non-negotiable rules in concise form: read policy before edits, sync main, inspect open PRs/issues, one lane/one carrier, reserve paths, continue existing carrier, no force/bypass/RED merge, no paid services, and exact-head green before merge.

- [ ] **Step 2: Add the detailed runbook**

Document `CLAIM -> WORK -> HANDOFF -> REFRESH -> MERGE`, reservation examples, overlap handling, stale-base handling, and the mandatory handoff payload containing head SHA, PASS/RED state, blocker, reservations, next action, and main-drift status.

- [ ] **Step 3: Add the PR template**

Include one machine-readable coordination block with placeholders plus checkboxes confirming open-PR search, reservation coverage, no paid resources, and fresh exact-head CI before merge.

- [ ] **Step 4: Verify static contract through the test suite**

Extend the Task 1 suite, if necessary, so it reads the committed root policy/template/runbook and asserts the required headings and machine-readable fields remain present.

---

### Task 4: Integrate coordination validation into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `scripts/agent-coordination.mjs`, GitHub event payload, read-only pull-request API.
- Produces: a cheap pull-request coordination gate before source/build verification.

- [ ] **Step 1: Add minimal permission**

Keep `contents: read` and add `pull-requests: read`. Do not add write/admin permissions.

- [ ] **Step 2: Add pull-request-only validation step**

Before dependency installation, run:

```yaml
- name: Verify agent coordination
  if: github.event_name == 'pull_request'
  env:
    GITHUB_TOKEN: ${{ github.token }}
  run: node scripts/agent-coordination.mjs
```

- [ ] **Step 3: Preserve all existing source/build/deploy dry-run checks**

Do not remove or weaken `npm run verify`, Wrangler dry-runs, screenshot capture, or artifact upload.

- [ ] **Step 4: Run full branch CI**

Expected: coordination validation PASS, `npm run verify` PASS, Wrangler dry-runs PASS, screenshots PASS, artifact upload PASS.

---

### Task 5: Carrier validation and merge

**Files:**
- PR metadata only; no new production files.

**Interfaces:**
- Consumes all previous tasks.
- Produces merged policy on `main`.

- [ ] **Step 1: Open one Draft carrier PR**

Use lane key `repo-agent-coordination-policy` and reserve every file in this plan. Record the exact branch base SHA and `Paid-Resources: FORBIDDEN`.

- [ ] **Step 2: Confirm the intentional RED phase**

Before implementation commits, confirm fresh PR CI fails specifically because the test contract references the missing coordination implementation.

- [ ] **Step 3: Push implementation and obtain fresh exact-head GREEN CI**

Do not bypass checks.

- [ ] **Step 4: Re-fetch current `main` and inspect drift**

If main changed, compare drift against this carrier's reservations. Refresh non-force if necessary.

- [ ] **Step 5: Mark ready and merge only if mergeable + exact-head green**

Never force, bypass, or merge RED.

- [ ] **Step 6: Verify post-merge `main` CI**

Confirm the merged SHA receives a green CI run and report the merge SHA and run status.

## Self-review

- Spec coverage: every success criterion maps to Tasks 1-5.
- Placeholder scan: implementation steps define exact fields, files, commands, and failure behavior; no implementation placeholders remain.
- Interface consistency: parser/validation export names are identical across Tasks 1 and 2.
- Scope: no runtime, Piper, Cloudflare media, or deployment topology code is included.
