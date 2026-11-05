import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import { disclosesBalance, type RejectionCode } from "./failure-code";
import type { Money } from "./money";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "./wager-transaction";
import type { Wallet } from "./wallet";
import { LedgerDirection } from "./wallet-ledger-entry";

export interface SettlementInput {
  /** `PENDING`, or `PENDING_REFERENCE` when the worker retries it. */
  transaction: WagerTransaction;
  /** Loaded under its lock, and the wallet this transaction names. */
  wallet: Wallet;
  /** Resolved by `(providerId, referenceExternalTransactionId)`, or absent when not found (FR-26). */
  reference: WagerTransaction | undefined;
  /** Whether a `PROCESSED` reversal already points at `reference` (ADR-0006). */
  referenceAlreadyReversed: boolean;
}

/**
 * What to do with the transaction. Every variant carries what the transition
 * needs, so the caller applies it and decides nothing.
 */
export type SettlementDecision =
  /** `direction` is absent for LOSS, which is applied without moving money. */
  | { outcome: "apply"; direction: LedgerDirection | undefined; referenceTransactionId: string | undefined }
  | { outcome: "reject"; code: RejectionCode; observedBalance: Money | undefined }
  | { outcome: "wait-reference"; observedBalance: Money };

/**
 * The settlement order of REQUIREMENTS section 3.5, steps 3 to 11, as a pure
 * function: no I/O, no state, nothing to inject. The same input always gives
 * the same code, because the checks run in a fixed order and the first to fail
 * wins. The order is the requirement: swapping two checks looks identical in
 * review and changes the `failureCode` a provider acts on.
 *
 * Steps 1 and 2 (wallet exists, idempotency) come before it, in the use case,
 * and step 12 (apply) after it. A rejection is returned, never thrown: it has to
 * commit with its inbox row and event, and an exception would invite a rollback.
 */
export function decideSettlement(input: SettlementInput): SettlementDecision {
  const { transaction, wallet, reference, referenceAlreadyReversed } = input;
  assertCoherent(input);

  const reject = (code: RejectionCode): SettlementDecision => ({
    outcome: "reject",
    code,
    observedBalance: disclosesBalance(code) ? wallet.balance : undefined,
  });

  // 3
  if (transaction.playerId !== wallet.playerId) return reject("PLAYER_WALLET_MISMATCH");
  // 4
  if (transaction.money.currency !== wallet.currency) return reject("CURRENCY_MISMATCH");

  // 5 to 10: only a transaction that declared a reference has any of this to check.
  if (transaction.referenceExternalTransactionId !== undefined) {
    // 6
    if (reference === undefined) return { outcome: "wait-reference", observedBalance: wallet.balance };
    // 7
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return reject("REFERENCE_MISMATCH");
    }
    // 8
    if (!transaction.acceptsReference(reference)) return reject("REFERENCE_KIND_NOT_ALLOWED");
    // 9: a reference that is still waiting keeps this one waiting, however long the chain.
    if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
      return { outcome: "wait-reference", observedBalance: wallet.balance };
    }
    if (reference.status !== Status.Processed) return reject("REFERENCE_NOT_PROCESSED");
    // 10
    if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
      return reject("REFERENCE_AMOUNT_MISMATCH");
    }
    // A WIN on a reversed BET is refused as well (INT-09). A LOSS only records an outcome, so it is not.
    if ((transaction.requiresReference() || transaction.kind === Kind.Win) && referenceAlreadyReversed) {
      return reject("ALREADY_REVERSED");
    }
  }

  // 11
  const direction = transaction.affectsBalance() ? transaction.ledgerDirectionFor(reference) : undefined;
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    return reject(transaction.kind === Kind.Bet ? "INSUFFICIENT_FUNDS" : "REVERSAL_INSUFFICIENT_FUNDS");
  }
  if (direction === LedgerDirection.Credit && !wallet.canCredit(transaction.money)) {
    return reject("BALANCE_LIMIT_EXCEEDED");
  }

  // 12 is the caller's: it applies this and marks the transaction PROCESSED.
  return { outcome: "apply", direction, referenceTransactionId: reference?.id };
}

/** A caller that breaks these has a bug. They are not business outcomes, so they throw. */
function assertCoherent({ transaction, wallet, reference }: SettlementInput): void {
  if (transaction.status !== Status.Pending && transaction.status !== Status.PendingReference) {
    throw new InvalidTransactionStateError(`a ${transaction.status} transaction is already settled`);
  }
  if (transaction.kind === Kind.Opening) {
    throw new InvalidWagerTransactionError("an OPENING is applied when the wallet is opened, not settled");
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError("the wallet is not the one the transaction names");
  }
  if (
    reference !== undefined &&
    reference.externalTransactionId !== transaction.referenceExternalTransactionId
  ) {
    throw new InvalidWagerTransactionError(
      "the reference is not the one the transaction declared (a transaction that declared none accepts none)",
    );
  }
}
