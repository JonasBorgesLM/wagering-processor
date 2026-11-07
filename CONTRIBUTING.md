# Contributing

Everything here is checked by CI, except where stated.

## Before pushing

```bash
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration   # needs: docker compose up -d --wait postgres sqs
bun run test:concurrency   # the same services; includes the multi-process failure suite, a few minutes
bun run test:mutation      # the same services; removes each protection in turn and fails if no test notices. Tens of minutes
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

## From issue to merge

Git is the source of truth for the system and its state: code, migrations, queue provisioning, Compose, CI and documents all change through a pull request.

1. Take an issue from the [project board](https://github.com/users/JonasBorgesLM/projects/10) and move it to In Progress.
2. Branch from `develop`: `feature/<issue>-<slug>`.
3. Open a pull request with `Closes #<issue>`, updating the documents the issue names.
4. `CI OK` passes, and the owner authorizes the merge.
5. Closing the issue moves it to Done.

Strict GitOps, where an agent reconciles a running environment from Git, does not apply: nothing here is deployed. If a deployment appears, its desired state belongs in this repository too.

## Documentation

A change to a route, a body or a status updates `docs/openapi.yaml` in the same pull request; `test/integration/openapi.test.ts` fails when it does not.

A change to behaviour updates its documents in the same pull request. CI fails when `src` or `migrations` change with no document touched, unless the PR is labelled `no-docs-needed` (NFR-12). Status lines in `README.md` and `ARCHITECTURE.md` must say what the code does today, not what is planned.

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
- A test guarding an invariant is removed from its protection once, seen red, then restored. For the protections listed in `test/mutation/mutants.ts` that is now mechanical (`bun run test:mutation`, weekly in CI): add a mutant there when you add a protection, with an exact string that occurs once in one file and the tests that must go red. For anything else it is still a review question on the PR template.
- Assert the expected answer, not the absence of a wrong one.
- Every test finishing on wallet state also asserts `balance == ledger rebuild`.

## Decisions

An ADR comes before the code it governs. An existing ADR may gain lines, never lose them. A genuine typo needs the `adr-typo` label.

## Not enforced

Named so nothing reads as more guaranteed than it is: that the commit body explains why, that a negative control was really run, that a changed document is correct, and any coverage threshold.
