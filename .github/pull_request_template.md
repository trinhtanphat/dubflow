## Summary

<!-- What does this PR change, and why? -->

## Agent coordination

<!-- Keep these machine-readable field names intact. Replace every placeholder before requesting review. -->
- Lane-Key: `replace-with-stable-kebab-case-lane`
- Carrier: `primary`
- Issue: `none`
- Base-SHA: `replace-with-full-40-character-base-sha`
- Depends-On: `none`
- Handoff-From: `none`
- Paid-Resources: `FORBIDDEN`
- Reserved-Paths:
  - `replace/with/exact-file-or-directory/**`

## Coordination checklist

- [ ] I fetched current `main` before starting and recorded the exact base SHA above.
- [ ] I searched open issues/PRs for the same feature, lane, and likely paths.
- [ ] There is no competing active primary carrier for this `Lane-Key`.
- [ ] `Reserved-Paths` covers every changed file in this PR.
- [ ] Any overlap warning with another lane is understood and sequenced/narrowed/handed off.
- [ ] `Paid-Resources` remains `FORBIDDEN`; this PR does not enable paid services implicitly.
- [ ] Before merge I will re-check main drift and require fresh exact-head green CI.

## Validation

<!-- Record relevant tests/checks. Do not mark a RED PR merge-ready. -->

## Handoff / next action

<!-- If unfinished, include exact head SHA, PASS/RED state, blocker, reservations, main-drift status, and one concrete next action. -->
