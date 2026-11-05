# Contributing

Everything here is checked by CI, except where stated.

## Before pushing

```bash
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration   # needs: docker compose up -d --wait postgres sqs
bun run check:docs
```

`bunx lefthook install` runs the fast checks as Git hooks. Hooks can be skipped, so CI remains the guarantee.

## Branches

Gitflow, with both long-lived branches protected:

| Branch | From | Into | Purpose |
| --- | --- | --- | --- |
| `main` | | | Released states only, each tagged |
| `develop` | `main` | `release/*` | Integration |
| `feature/*` | `develop` | `develop` | One phase or subject |
| `docs/*` | `develop` | `develop` | Documentation only |
| `release/vX.Y.Z` | `develop` | `main`, then back to `develop` | Stabilizing a release |
| `hotfix/*` | `main` | `main`, then back to `develop` | Fixing a release |

- Merges use `--no-ff`, not squash, so each atomic commit stays reviewable and revertible.
- **Every merge needs the owner's explicit authorization.** No approval is enforced by GitHub, so this rule depends on stopping at the pull request.
- **Stacked pull requests have an order:** retarget the dependent one before deleting its base branch, or GitHub closes it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), checked by commitlint on each commit and on the PR title.

```text
<type>(<scope>)!: <subject>      imperative, 72 characters or fewer, no period

<body: why, not what>

Refs FR-22
```

- **Scopes:** see `commitlint.config.cjs`.
- **One subject per commit**, staged explicitly. No `git add -A` across subjects.

## Tests

- Real PostgreSQL and SQS for integration and concurrency tests. A test that replaces them does not count.
- A test guarding an invariant is removed from its protection once, seen red, then restored. There is no mechanical check for this, so it is a review question on the PR template.
- Assert the expected answer, not the absence of a wrong one.
- Every test finishing on wallet state also asserts `balance == ledger rebuild`.

## Decisions

An ADR comes before the code it governs. An existing ADR may gain lines, never lose them. A genuine typo needs the `adr-typo` label.

## Not enforced

Named so nothing reads as more guaranteed than it is: that the commit body explains why, that a negative control was really run, and any coverage threshold.
