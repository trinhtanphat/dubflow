# Agent coordination and reservation design

## Goal

Prevent parallel coding agents from duplicating the same feature, editing the same files without awareness, or creating competing carrier PRs in the YupVox/DubFlow repository.

The repository must expose one small, GitHub-native coordination protocol that an agent can discover before changing code and that CI can validate without introducing a new paid service or external coordination database.

## Current problem

The repository already has many feature specs and implementation plans under `docs/superpowers`, but those documents are feature-local. They do not provide a single repository-wide source of truth for active ownership.

Recent browser-Piper work demonstrated the failure mode: more than one draft PR can be created for substantially the same lane before the agents notice each other. The result is duplicated implementation, overlapping changed files, stale branches, and unnecessary reconciliation work.

## Constraints

- GitHub remains the coordination system of record.
- No paid service, paid API, AI Gateway top-up, Cloudflare Container, Cloudflare Stream, or other new paid coordination dependency.
- Do not create a database, lock server, bot service, or queue solely for agent coordination.
- `main` remains the integration branch.
- Never force-update an integration carrier to bypass another agent.
- Never bypass RED CI or merge an exact-head RED PR.
- Existing in-flight PRs created before this policy are treated as legacy and are not retroactively rejected solely for lacking the new metadata.
- One logical feature/issue lane has one active primary carrier PR.
- A handoff should continue the existing carrier whenever branch permissions allow; opening a second carrier with the same lane key is an error.
- Path overlap between different lanes is initially a warning, not a hard failure, because some cross-cutting changes legitimately touch shared files.

## Repository surfaces

The coordination protocol uses four visible surfaces and one verifier:

1. `AGENTS.md` at repository root: short mandatory rules every coding agent reads before work.
2. `.github/pull_request_template.md`: machine-readable coordination metadata collected when a PR is opened.
3. `docs/AGENT-COORDINATION.md`: full claim, work, handoff, refresh, merge, and recovery runbook.
4. Feature spec/plan documents: remain the detailed design source for each lane.
5. `scripts/agent-coordination.mjs`: CI verifier for metadata, lane uniqueness, changed-file reservation coverage, and overlap warnings.

## Coordination metadata contract

Every non-exempt PR created after this policy is expected to contain this block:

```text
## Agent coordination
- Lane-Key: `stable-kebab-case-key`
- Carrier: `primary`
- Issue: `#123` or `none`
- Base-SHA: `40-character commit SHA`
- Depends-On: `none` or `#123`
- Handoff-From: `none` or `#123`
- Paid-Resources: `FORBIDDEN`
- Reserved-Paths:
  - `path/to/file.ts`
  - `path/to/directory/**`
```

`Lane-Key` is the stable logical ownership key. It must identify the feature or bug, not the agent or branch name.

`Carrier` is `primary` for the one active implementation PR. The first policy version does not create parallel secondary carriers.

`Base-SHA` records the main/base commit used when the carrier was started or most recently deliberately refreshed. CI validates shape but does not require it to equal today's moving `main` tip; freshness is checked again before merge.

`Paid-Resources` must be exactly `FORBIDDEN`. This makes the repository's zero-cost constraint explicit in every agent carrier.

## Reservation syntax

A reserved path is one of:

- an exact repository-relative file path, for example `src/app/StudioShell.tsx`;
- a directory prefix ending in `/**`, for example `src/features/voice/**`.

Leading `/`, parent traversal (`..`), empty paths, and other wildcard shapes are invalid. Keeping the syntax narrow makes overlap checks deterministic.

Every file changed by the PR must be covered by at least one reservation in that PR. This turns reservation metadata into an auditable claim rather than a decorative note.

## Active lane uniqueness

On a pull-request CI event, the verifier lists open PRs in the same repository. If another open, policy-aware PR has the same `Lane-Key`, the current PR fails coordination verification.

Legacy PRs without a parseable coordination block are ignored for lane-key enforcement because they predate this contract. Agents are still required by `AGENTS.md` to inspect open PRs before starting a new lane.

## Path overlap behavior

If the current PR reserves a path that overlaps a path reserved by another policy-aware open PR with a different lane key, CI emits a GitHub warning that names the other PR, lane key, and overlapping reservations.

Overlap is warning-only in version 1. The agent must resolve the overlap by narrowing scope, sequencing dependencies, or documenting a handoff. A later policy may promote selected high-risk paths to hard locks after enough production experience.

## Changed-file coverage

The verifier retrieves the current PR changed-file list and checks every file against `Reserved-Paths`.

A changed file outside the reservation set is a hard failure. The fix is to either:

- add the genuinely intended path to the reservation block; or
- revert the accidental edit.

This catches silent scope growth and makes the PR body a reliable ownership snapshot.

## Exemptions

Repository automation accounts may be exempt from the human/agent coordination block when they are clearly generated dependency or GitHub automation PRs. The initial allowlist is intentionally narrow:

- `dependabot[bot]`
- `renovate[bot]`
- `github-actions[bot]`

All normal user and coding-agent PRs are subject to the policy.

## Agent workflow

### Claim

1. Fetch current `main` and record exact SHA.
2. Search open issues and PRs for the intended feature and likely files.
3. If a carrier already exists, continue or hand off that carrier instead of opening a duplicate.
4. Create a feature branch from current `main`.
5. Open one Draft PR early with a unique lane key and explicit reserved paths.

### Work

1. Stay inside reserved paths.
2. Add reservations before deliberately expanding scope.
3. Re-check open PRs when main changes materially or before editing a shared hotspot.
4. Keep paid resources forbidden unless the user explicitly changes the project-wide constraint.

### Handoff

A handoff note must preserve:

- current head SHA;
- exact PASS/RED state;
- blocker/root cause if known;
- currently reserved paths;
- next concrete action;
- whether main drift was checked.

The preferred handoff is another agent continuing the same PR and branch.

### Merge

Before merge:

1. re-fetch current `main`;
2. verify there is still no duplicate active lane;
3. inspect main drift for overlap with the carrier;
4. refresh non-force when required;
5. run fresh exact-head CI;
6. merge only when exact-head CI is green and the PR is mergeable;
7. never force, bypass, or merge RED.

## CI integration

The existing `CI` workflow remains the only normal source/build verification workflow. It gains `pull-requests: read` permission and a pull-request-only coordination step before the expensive source/build checks.

The verifier is also covered by a deterministic Node test suite run from `verify:deploy-config`. Unit tests exercise metadata parsing, invalid reservations, lane duplication, changed-file coverage, overlap detection, and bot exemption without network calls.

The live CLI path uses the GitHub event payload plus the repository API. It fails closed if it cannot validate the current non-exempt PR metadata or changed-file scope. Network/API failures are reported distinctly from policy failures.

## Non-goals

- No automatic branch rebasing.
- No automatic PR closing or force-updating.
- No automatic file locking outside GitHub metadata.
- No attempt to infer semantic code conflicts from source text.
- No paid coordination backend.
- No change to the YupVox runtime, Cloudflare deployment topology, voice/Piper implementation, or production media qualification lane.

## Success criteria

The policy is complete when:

- repository root tells agents how to avoid duplicate work;
- every new normal PR receives a standard coordination block;
- CI rejects missing/invalid coordination metadata;
- CI rejects duplicate policy-aware lane keys;
- CI rejects changed files outside the PR reservation set;
- CI warns on cross-lane reserved-path overlap;
- zero-cost/no-paid constraints are explicit;
- existing source/build/deploy verification still passes;
- the policy carrier itself is merged to `main` only after fresh exact-head green CI.
