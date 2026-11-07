import { InvalidIntegrationEventError } from "./errors";
import { isRejectionCode, type RejectionCode } from "./failure-code";
import { type EventContext, IntegrationEvent } from "./integration-event";
import type { MoneyProps } from "./money";
import {
  WagerTransactionStatus as Status,
  type WagerTransaction,
  type WagerTransactionKind,
} from "./wager-transaction";
import type { Wallet } from "./wallet";
import type { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

// Every event carries the wallet id as its aggregate id, so the outbox's message group keeps all of a wallet's
// events in order on a FIFO queue (ADR-0007). The transaction an event is about is in `data`.

/** What identifies an operation to a consumer, without repeating the balance or the outcome. */
interface TransactionFacts {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function factsOf(transaction: WagerTransaction): TransactionFacts {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, status: Status, event: string): void {
  if (transaction.status !== status) {
    throw new InvalidIntegrationEventError(
      `${event} describes a ${status} transaction, not a ${transaction.status} one`,
    );
  }
}

// ---- WagerTransactionProcessed

export interface WagerTransactionProcessedData extends TransactionFacts {
  /** The wallet balance after the operation. For a LOSS this is the balance it saw, since nothing moved. */
  balance: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

/** Any applied transaction, a LOSS included, whether or not it moved money (§11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, Status.Processed, "WagerTransactionProcessed");
    const { observedBalance, processedAt } = transaction;
    if (!observedBalance || !processedAt) {
      throw new InvalidIntegrationEventError("a processed transaction must carry its balance and time");
    }
    return new WagerTransactionProcessed({
      ...baseProps(transaction, context),
      data: {
        ...factsOf(transaction),
        balance: observedBalance.toJSON(),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

// ---- WagerTransactionRejected

export interface WagerTransactionRejectedData extends TransactionFacts {
  failureCode: RejectionCode;
  /** Absent when the rejection must not disclose one (FR-58), so the stream cannot leak what the response withholds. */
  balance?: MoneyProps;
}

/** A business rule refused the transaction, including a pending reference that never arrived (FR-42). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, Status.Rejected, "WagerTransactionRejected");
    const failureCode = transaction.failureCode;
    if (!isRejectionCode(failureCode)) {
      throw new InvalidIntegrationEventError("a rejected transaction must carry a rejection code");
    }
    return new WagerTransactionRejected({
      ...baseProps(transaction, context),
      data: {
        ...factsOf(transaction),
        failureCode,
        ...(transaction.observedBalance ? { balance: transaction.observedBalance.toJSON() } : {}),
      },
    });
  }
}

// ---- WagerTransactionPendingReference

export interface WagerTransactionPendingReferenceData extends TransactionFacts {
  /** The provider's id for what this transaction is waiting for. */
  referenceExternalTransactionId: string;
  balance: MoneyProps;
}

/** Published once, when a transaction first starts to wait, and not on each retry. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, Status.PendingReference, "WagerTransactionPendingReference");
    const { referenceExternalTransactionId, observedBalance } = transaction;
    if (referenceExternalTransactionId === undefined || !observedBalance) {
      throw new InvalidIntegrationEventError("a waiting transaction must carry its reference and balance");
    }
    return new WagerTransactionPendingReference({
      ...baseProps(transaction, context),
      data: { ...factsOf(transaction), referenceExternalTransactionId, balance: observedBalance.toJSON() },
    });
  }
}

// ---- WalletBalanceChanged

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** Lets a consumer restore the order of balance changes, because retries can reorder events (FR-91). */
  walletVersion: number;
}

/** Only when the balance moved: a LOSS and every rejection publish nothing of this kind (§11). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError("the ledger entry belongs to another wallet");
    }
    // The event describes the state the wallet is in now. An entry from an earlier moment would publish a stale balance.
    if (entry.walletVersion !== wallet.version || !entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidIntegrationEventError("the ledger entry is not the wallet's latest change");
    }
    return new WalletBalanceChanged({
      eventId: context.eventId,
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function baseProps(transaction: WagerTransaction, context: EventContext) {
  return {
    eventId: context.eventId,
    aggregateId: transaction.walletId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    occurredAt: context.occurredAt,
  };
}
