# Architecture Decision Records

Every contested decision is recorded here, before the code it governs. **An ADR is never edited to reflect a later change of mind.** It is amended with a section naming what superseded which part, so the reasoning that was current stays readable.

CI enforces the mechanical form: an existing ADR may gain lines, never lose them.

New records start from [`TEMPLATE.md`](TEMPLATE.md).

## Index

| ADR | Title | Status | Amended by |
| --- | --- | --- | --- |
| [`0001`](0001-one-deployable-with-role-selected-processes.md) | One deployable, with processes selected by role | Accepted | — |
| [`0002`](0002-persistence-records-are-separate-from-domain-classes.md) | MikroORM maps persistence records, and mappers build domain classes | Accepted | Amended by its own note on issue #11 |
| [`0003`](0003-wallet-row-lock-is-taken-before-any-insert.md) | Concurrency uses a wallet row lock, taken before any insert | Accepted | — |
| [`0004`](0004-money-is-bigint-minor-units.md) | Money is held as bigint minor units in the domain | Accepted | — |
| [`0005`](0005-idempotency-is-enforced-by-two-unique-keys.md) | Idempotency rests on two unique keys and a stored result | Accepted | — |
| [`0006`](0006-one-processed-reversal-per-reference.md) | A reference accepts one processed reversal, of any kind | Accepted, confirmed by the owner | — |
| [`0007`](0007-outbox-claims-with-a-lease.md) | Outbox publishers claim rows with a lease | Accepted | — |
| [`0008`](0008-ministack-is-the-local-sqs.md) | MiniStack is the local SQS | Accepted | — |
| [`0009`](0009-authentication-is-a-documented-extension-point.md) | Authentication is a documented extension point, not implemented | Accepted | — |
| [`0010`](0010-http-settles-synchronously.md) | HTTP submissions settle synchronously | Accepted | — |
| [`0011`](0011-typescript-stays-on-6-until-tooling-supports-7.md) | TypeScript stays on 6 until the boundary check supports 7 | Accepted | — |
| [`0012`](0012-errors-are-one-envelope-with-one-mapping.md) | Errors are one envelope with one mapping, applied at two places | Accepted | — |

## Reopening criteria on the record

| ADR | Reopen when |
| --- | --- |
| `0003` | Load tests show a realistic hot wallet exhausting the pool |
| `0006` | A provider contract requires re-reversal |
| `0008` | A contract test fails on MiniStack |
| `0009` | All mandatory tests pass with time left, or any deployment leaves a private network |
| `0011` | `dependency-cruiser` analyses modules under TypeScript 7 |
| `0012` | A provider or gateway requires `application/problem+json`, or a second platform endpoint needs the envelope |

## Open questions

- **Delivery format:** the challenge does not state a deadline or how to submit.
