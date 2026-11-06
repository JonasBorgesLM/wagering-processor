import type { IntegrationEvent } from "../domain/integration-event";
import type { SettlementDecision } from "../domain/settlement-policy";
import type { WagerTransaction } from "../domain/wager-transaction";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/wagering-events";
import type { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import type { IdGenerator, TransactionContext } from "./ports";

export interface OutcomeContext {
  ids: IdGenerator;
  now: Date;
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Applies a decision that ends a transaction, whichever way it got here: a new one is inserted (`persist: "insert"`),
 * one that was waiting for its reference is updated. The effects are the same either way, and so are the events, so
 * the rules about them live once (FR-25, FR-55, FR-60).
 *
 * The caller holds the wallet lock and enqueues the events it gets back in the same transaction.
 */
export async function applyOutcome(
  tx: TransactionContext,
  context: OutcomeContext,
  transaction: WagerTransaction,
  wallet: Wallet,
  decision: Extract<SettlementDecision, { outcome: "apply" | "reject" }>,
  persist: "insert" | "update",
): Promise<Array<IntegrationEvent<object>>> {
  const eventContext = () => ({
    eventId: context.ids.next(),
    correlationId: context.correlationId,
    causationId: context.causationId,
    occurredAt: context.now,
  });
  const write = (): Promise<void> =>
    persist === "insert" ? tx.transactions.insert(transaction) : tx.transactions.update(transaction);
  const events: Array<IntegrationEvent<object>> = [];

  if (decision.outcome === "reject") {
    transaction.reject(decision.code, decision.observedBalance);
    await write();
    events.push(WagerTransactionRejected.from(transaction, eventContext()));
    return events;
  }

  const movement = { transactionId: transaction.id, entryId: context.ids.next(), at: context.now };
  const entry =
    decision.direction === undefined
      ? undefined
      : decision.direction === LedgerDirection.Debit
        ? wallet.debit(transaction.money, movement)
        : wallet.credit(transaction.money, movement);
  transaction.markProcessed(decision.referenceTransactionId, wallet.balance, context.now);
  // The transaction first: the ledger entry's foreign key points at it.
  await write();
  events.push(WagerTransactionProcessed.from(transaction, eventContext()));
  if (entry) {
    await tx.wallets.save(wallet);
    await tx.ledger.append(entry);
    events.push(WalletBalanceChanged.from(wallet, entry, eventContext()));
  }
  return events;
}
