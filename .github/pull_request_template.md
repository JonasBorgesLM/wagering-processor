<!-- The title must be a Conventional Commit. -->

## What and why

<!-- The diff says what changed. Say why it needed to. -->

## Traceability

- Requirements: <!-- FR-22, NFR-02, or "none" with a reason -->
- Decisions: <!-- ADR-0003, or "none" -->
- Closes: <!-- #12 -->

## Correctness checklist

Delete the lines that do not apply; do not delete the ones that do.

- [ ] Each new invariant has a test **seen failing** with its protection removed. Negative control noted below.
- [ ] Money stays out of `number`, in every layer.
- [ ] No network call inside a SQL transaction.
- [ ] The wallet lock still comes before any insert referencing the wallet.
- [ ] Events are written through the outbox only.
- [ ] Tests use real PostgreSQL and SQS, and assert `balance == ledger rebuild`.

## Negative controls

<!-- What was removed, and what went red. -->

## Documentation

- [ ] A structural decision here has an ADR, written before the code.
- [ ] Status lines in `README.md` and `ARCHITECTURE.md` are still true.
