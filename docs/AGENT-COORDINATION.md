# Agent Coordination Runbook

This document defines how multiple coding agents coordinate work in YupVox/DubFlow without duplicating features, overwriting each other, or relying on a paid coordination service.

The repository uses GitHub itself as the source of truth: open PRs are active carriers, PR bodies declare lane ownership and path reservations, and CI validates the contract.

## Core rule

**One logical lane = one active primary carrier PR.**

A lane is a feature, bug, migration, production qualification item, or other coherent unit of work. The `Lane-Key` must remain stable across handoffs. It is not an agent name and should not be regenerated when another agent continues the same work.

Examples:

```text
browser-piper-zero-cost-voice
production-r2-media-qualification
studio-segment-split
repo-agent-coordination-policy
```

## CLAIM

Before editing production code:

1. Fetch `main` and record the exact SHA.
2. Search open issues and PRs for:
   - the intended feature/bug;
   - likely source paths;
   - related acceptance/spec names;
   - existing Draft PRs.
3. If an existing PR already carries the work, continue it. Do not create a duplicate carrier merely because another agent started it.
4. If no carrier exists, create a branch from current `main` and open one Draft PR early.
5. Fill the complete `## Agent coordination` block.
6. Reserve every file or directory the planned work is expected to change.

### Required metadata

```text
## Agent coordination
- Lane-Key: `stable-kebab-case-key`
- Carrier: `primary`
- Issue: `#123` or `none`
- Base-SHA: `0123456789abcdef0123456789abcdef01234567`
- Depends-On: `none` or `#123`
- Handoff-From: `none` or `#123`
- Paid-Resources: `FORBIDDEN`
- Reserved-Paths:
  - `path/to/file.ts`
  - `path/to/directory/**`
```

`Base-SHA` records the deliberate base used to begin or refresh the carrier. It is allowed to become older than moving `main`; freshness is revalidated in REFRESH/MERGE.

## Reservation syntax

Reservations are intentionally simple.

Allowed:

```text
src/app/StudioShell.tsx
src/features/voice/**
worker/index.ts
```

Not allowed:

```text
/worker/index.ts
../worker/**
src/*/voice/**
**
```

Use exact files or one directory prefix ending in `/**`. Every changed file must be covered by the PR's `Reserved-Paths`.

A broad reservation is not permission to refactor unrelated code. Reserve only the smallest coherent scope that the lane actually needs.

## WORK

During implementation:

1. Stay inside the reserved scope.
2. If a required file is outside scope, inspect open PRs again before adding the reservation.
3. Update the PR body first when expanding reservations deliberately.
4. If CI reports a changed file outside reservations, either reserve it intentionally or revert it.
5. If CI warns about an overlap with another lane, resolve the interaction before continuing deep edits.
6. Keep design/spec/plan and current acceptance state linked from the carrier PR when the feature requires them.
7. Preserve the project zero-cost constraint: `Paid-Resources: FORBIDDEN`.

### Overlap handling

Version 1 treats cross-lane reservation overlap as a warning, not an automatic failure.

When warned:

- **Narrow** one carrier if the overlap is accidental.
- **Sequence** the carriers with `Depends-On` if both legitimately need the path.
- **Handoff** ownership if one carrier supersedes the other.
- **Reconcile** against fresh `main` after the first carrier merges.

Do not use force-push or blind overwrite to resolve overlap.

## HANDOFF

The preferred handoff is another agent continuing the same existing PR and branch.

A handoff message/checkpoint must include:

```text
Lane-Key: <lane>
PR: #<number>
Head-SHA: <exact 40-char SHA>
State: PASS | RED | IN-PROGRESS
Run/Check: <id or none>
Blocker: <root cause or none>
Reserved-Paths: <current list>
Main-Drift-Checked: yes | no
Next-Action: <one concrete next action>
Paid-Resources: FORBIDDEN
```

If branch access makes continuation impossible, close or clearly supersede the old carrier before a replacement with the same lane key becomes active. Do not leave two active primary carriers for the same lane.

## REFRESH

Reconcile moving `main` without destroying other work.

1. Fetch the latest `main` SHA.
2. Compare commits between the carrier base/head and latest `main`.
3. Inspect whether main drift overlaps `Reserved-Paths`.
4. If there is no relevant drift, record that finding and keep the carrier focused.
5. If refresh is required, use a normal non-force merge/rebase strategy permitted by the repository and re-run tests.
6. Update `Base-SHA` in the PR body when you deliberately establish a new reviewed base.
7. Never force a stale carrier over new main changes.

`main drift` must be checked again before final merge, even if it was checked earlier in the work.

## MERGE

A carrier is eligible to merge only when all of the following are true:

- it is the only active primary carrier for its `Lane-Key`;
- every changed file is covered by `Reserved-Paths`;
- any reservation-overlap warnings have been consciously reconciled;
- latest main drift has been inspected;
- the PR is mergeable;
- fresh exact-head CI is green;
- the exact head SHA has not moved since that green run;
- no paid resource was enabled implicitly;
- no required safety/deployment gate was bypassed.

Then mark the PR ready and merge using a normal repository merge method. Never merge RED.

After merge, verify the resulting `main` CI run before declaring the lane complete.

## Paid-resource policy

Default project policy is strict zero-cost coordination and fail-closed paid provider behavior.

Forbidden unless the user explicitly changes the constraint:

- AI Gateway credit top-up;
- Cloudflare Containers;
- Cloudflare Stream;
- automatic paid Grok TTS fallback;
- automatic ElevenLabs usage;
- introducing a paid coordination SaaS or lock service.

A carrier cannot silently reinterpret `Paid-Resources: FORBIDDEN`.

## Legacy PRs

PRs opened before this policy may not contain a coordination block. CI does not use a legacy PR's missing metadata as a duplicate-lane hard error for another PR.

Agents must still inspect those legacy PRs manually before claiming work. If a legacy PR is actively carrying the same feature, continue or reconcile it instead of exploiting the legacy exemption to open duplicate work.

## CI behavior

For normal pull requests, `scripts/agent-coordination.mjs` performs four checks before expensive build work:

1. required coordination metadata is valid;
2. no other policy-aware open PR owns the same `Lane-Key`;
3. every changed file is covered by `Reserved-Paths`;
4. overlapping reservations in different lanes produce warnings.

Known dependency/automation actors are exempt:

```text
dependabot[bot]
renovate[bot]
github-actions[bot]
```

The verifier uses only read-only GitHub API access and Node built-ins. There is no external coordination database or paid service.

## Recovery examples

### Agent discovers an existing carrier

Do not create a new branch/PR. Read its spec, head SHA, checks, reservations, and latest handoff; continue that carrier.

### Agent already created a duplicate PR

Stop implementation. Determine which carrier is authoritative, transfer any unique useful changes deliberately, then close/supersede the duplicate. Preserve one active lane.

### Shared file is required by two lanes

Keep separate lane keys, reserve the shared file in both, accept the warning temporarily, add dependency ordering, and merge/reconcile sequentially.

### Current PR changed an unreserved file

Do not weaken the verifier. Either add a justified reservation to the PR body or revert the out-of-scope change.

### Main changes while CI is green

Green CI is evidence for the exact tested head/base context, not permission to ignore new main drift. Re-check drift and refresh non-force when relevant before merge.
