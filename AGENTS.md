# Agent Working Rules

This file is the repository-wide coordination contract for coding agents working on YupVox/DubFlow.

## Before changing code

1. Read `docs/AGENT-COORDINATION.md`.
2. Fetch current `main` and record the exact 40-character SHA.
3. Search open issues and pull requests for the same feature, bug, subsystem, and likely files.
4. If a carrier PR already exists, continue that carrier or perform a documented handoff. Do not open a competing carrier for the same lane.
5. Create work from current `main`; never start production changes directly on `main`.

## Ownership rules

- One logical feature/issue lane has **one active primary carrier** PR.
- Every normal PR must include the `## Agent coordination` block from `.github/pull_request_template.md`.
- `Lane-Key` identifies the logical work, not the agent or branch name.
- `Reserved-Paths` must cover every file the PR changes.
- Use exact file reservations or directory reservations ending in `/**` only.
- If another open PR reserves an overlapping path, coordinate scope, dependency order, or handoff before editing further.
- Add a reservation before intentionally expanding scope; otherwise revert the accidental edit.

## Safety rules

- `Paid-Resources` is `FORBIDDEN` unless the user explicitly changes that project-wide constraint.
- Do not top up AI Gateway or other credits.
- Do not enable Cloudflare Containers or Cloudflare Stream.
- Do not silently enable paid Grok, ElevenLabs, or another paid provider.
- Do not force-update a carrier to bypass another agent.
- Do not bypass CI, checks, or repository safety gates.
- Do not merge a RED PR.

## Handoff rules

When stopping or transferring work, preserve:

- current exact head SHA;
- exact PASS/RED state and relevant run/check ID;
- known blocker/root cause;
- current `Reserved-Paths`;
- next concrete action;
- whether current `main` drift was checked.

Prefer handing off the existing PR/branch instead of creating a replacement carrier.

## Merge rules

Before merge:

1. Re-fetch current `main`.
2. Re-check open PRs for duplicate `Lane-Key` and reservation overlap.
3. Inspect main drift against the carrier's reserved paths.
4. Refresh non-force when required.
5. Obtain fresh **exact-head** green CI.
6. Merge only while the PR is mergeable and the exact head remains unchanged.

Never force, bypass, or merge RED.

See `docs/AGENT-COORDINATION.md` for the complete `CLAIM -> WORK -> HANDOFF -> REFRESH -> MERGE` runbook.
