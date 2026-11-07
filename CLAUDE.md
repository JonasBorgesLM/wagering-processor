# CLAUDE.md

Guidance for Claude Code in this repository. General engineering rules live in `~/.claude/CLAUDE.md`.

## Project Overview

A distributed wagering processor for the Jungle Gaming backend challenge. Its value is financial correctness under duplicates, reordering, concurrency and crashes. It is **not** responsible for authentication, round lifecycle or partial reversals.

Rules: `REQUIREMENTS.md`. Design: `ARCHITECTURE.md`. Decisions: `docs/adr/`.

## Non-negotiable Invariants

Each is an elimination criterion in the challenge:

- No `number`, `float` or `double` for money. `Money` holds a `bigint` (ADR-0004).
- No negative balance, no duplicate debit or credit, even if the code is wrong: the schema enforces it (NFR-02).
- Idempotency is only ever persistent, never a memory cache.
- Correct with several instances: no in-process lock, and no state shared between instances.
- No event is published before commit. Events go through the outbox only.
- The ledger is append-only. Never update or delete an entry, including in tests or migrations.
- Every required test uses real PostgreSQL and real SQS. Mocking them is an elimination criterion.

## Settlement Order

The wallet lock comes **before** any insert referencing the wallet (ADR-0003). Inserting first deadlocks, and a test reproduces it. No network call inside a transaction.

A rejection is a returned value that commits, not an exception.

## Layers

`domain` imports only itself. `application` imports `domain` and its own ports. Checked by `check-boundaries.sh` (NFR-09).

## Commands

```bash
bun install
docker compose up -d --wait postgres sqs
bun run provision && bun run migrate up
bun run start
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run check:docs
```

## Git

Gitflow: work branches from `develop`, PR back into `develop`. **Commits and pushes on working branches are allowed; every merge needs the owner's explicit authorization.** Protection does not require approval, so stopping at the PR is the rule, not a limit GitHub enforces. Repository stays private until the owner makes it public at delivery.

## Conventions

- All text, code and commits in English (NFR-08).
- Tests guarding an invariant must be seen failing: note the negative control in the PR.
- An ADR comes before the code it governs, and is amended, never rewritten.
- Cite requirement ids in tests and commits. `§n` in `REQUIREMENTS.md` means a section of the challenge README.

## Known Constraints

- TypeScript is pinned to 6 because `dependency-cruiser` analyses nothing under 7 (ADR-0011).
- LocalStack now requires a licence token, hence MiniStack (ADR-0008).
- Nest re-raises the signal after shutdown hooks. A clean `SIGTERM` exits with code 143 as a normal process and 0 as PID 1 in a container. Both were observed; check for the `Draining` log, not only the code.
