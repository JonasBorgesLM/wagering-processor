import { type FailureCode, INFRASTRUCTURE_FAILURE_CODES, REJECTION_CODES } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from "./records";

/**
 * A stored value the code does not recognise. The schema's CHECKs make this
 * unreachable while the code and the schema agree, so it means they have
 * drifted, and failing loudly beats carrying an unknown string into the domain.
 */
export class PersistenceMappingError extends Error {
  override readonly name = "PersistenceMappingError";
}

// ---- wallet

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

// ---- wager transaction

/** `updatedAt` is persistence's, not the domain's, so whoever writes the row says when. */
export function transactionToRecord(transaction: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
    processedAt: transaction.processedAt ?? null,
    createdAt: transaction.createdAt,
    updatedAt,
  };
}

export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: oneOf(Object.values(WagerTransactionKind), record.kind, "kind"),
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: oneOf(Object.values(WagerTransactionStatus), record.status, "status"),
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: optional(record.failureCode, (code) =>
      oneOf<FailureCode>([...REJECTION_CODES, ...INFRASTRUCTURE_FAILURE_CODES], code, "failureCode"),
    ),
    // The balance is in the transaction's own currency, which is the row's.
    observedBalance: optional(record.observedBalance, (amount) => money(amount, record.currency)),
    processedAt: record.processedAt ?? undefined,
  });
}

// ---- ledger entry

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

/** Rehydrates without re-validating, so a corrupt stored entry still loads and reports itself unbalanced (FR-70). */
export function ledgerEntryFromRecord(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: oneOf(Object.values(LedgerDirection), record.direction, "direction"),
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

// ---- helpers

/** A NULL column is `null` from the ORM and `undefined` in the domain. Both are treated as absent, so a partial load cannot read as an unknown value. */
function optional<T>(value: string | null | undefined, convert: (present: string) => T): T | undefined {
  return value === null || value === undefined ? undefined : convert(value);
}

function money(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

function oneOf<T extends string>(allowed: readonly T[], value: string, field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new PersistenceMappingError(`unknown ${field} in a stored row: ${JSON.stringify(value)}`);
  }
  return value as T;
}
