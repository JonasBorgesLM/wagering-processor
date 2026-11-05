# ADR-0006: A reference accepts one processed reversal, of any kind

## Status
Accepted. Confirmed by the project owner on 2026-11-05.

## Context
The challenge's rule 7.4 forbids reversing a reference twice "by the same type of operation". The §7 table says each reversal happens "once". §3 forbids duplicate credit. Read alone, 7.4 leaves room for this:

```text
BET 80 → -80 | REFUND → +80 | ROLLBACK of the BET → +80 = 80 created from nothing
```

7.4 is a prohibition, not a permission: forbidding the mix breaks no written rule.

## Decision
A partial unique index on `reference_transaction_id`, for `PROCESSED` `REFUND` and `ROLLBACK` rows. `REJECTED` and `PENDING_REFERENCE` reversals do not use the reference up. The wallet lock produces the readable `ALREADY_REVERSED`; the index is the guard if the code is wrong.

## The alternative that was rejected
**`UNIQUE (reference, kind)`, the literal reading.** It allows the double credit above unless code prevents it, leaving an elimination criterion guarded only by application logic, against §5.9.

**Allowing a second reversal once the first was itself rolled back.** `REFUND`, `ROLLBACK` of it, then `ROLLBACK` of the `BET` nets out correctly, so refusing it is a false rejection. Permitting it needs a query over reversal chains, which no constraint can express.

## Consequences
- That chain is refused with `ALREADY_REVERSED` and needs an operator. It is rare, loud and safe, whereas a wrong credit would be quiet.
- If an evaluator expects the literal reading, this deviates by design, and `INT-06` in the requirements says why.

## Reopening criterion
A provider contract requiring re-reversal, which would also need a reversal-chain model.
