# ADR-0008: MiniStack is the local SQS

## Status
Accepted

## Context
The challenge accepts LocalStack or MiniStack. Anyone evaluating the project must be able to run it with Docker alone.

Tested on 2026-11-05: `localstack/localstack:2026.10` exits with code 55 and `No credentials were found ... LOCALSTACK_AUTH_TOKEN`. `ministackorg/ministack:1.5.37` starts with no account, using a 261 MB image against 1.67 GB.

## Decision
MiniStack, pinned by version. `test/integration/sqs-runtime.test.ts` checks the semantics the consumer depends on: deduplication ids, FIFO group hold, `ChangeMessageVisibility`, receive counts and DLQ redrive (IR-02).

## The alternative that was rejected
**LocalStack with an auth token.** It is the better-known emulator, but needs every evaluator to create an account and supply a secret, and CI to store one. An older unlicensed tag would avoid that at the price of an unmaintained image.

## Consequences
- Emulator behaviour can differ from AWS. The contract tests narrow that to what this system depends on, and do not prove parity.
- Those tests must run on any MiniStack upgrade.

## Reopening criterion
A contract test failing on MiniStack, or the project targeting real AWS.
