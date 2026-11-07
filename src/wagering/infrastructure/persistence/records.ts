/**
 * The shape of each table, as plain data (ADR-0002).
 *
 * These are not domain classes and carry no rules: they are what the database
 * holds, mapped by `schemas.ts` and converted to and from the domain by
 * `mappers.ts`. Nothing above infrastructure imports them.
 *
 * Amounts are strings because PostgreSQL's `numeric` reaches JavaScript as an
 * exact string, and a number would lose cents past 2^53. A nullable column is
 * `null` here, where the domain says `undefined`.
 */

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  processedAt: Date | null;
  createdAt: Date;
  /** Persistence's own audit column: the domain does not track it, so the caller supplies it. */
  updatedAt: Date;
  /**
   * The schedule of a transaction waiting for its reference. Persistence's, not the domain's: a new row has none,
   * and it is set by `scheduleRetry` and read by the worker's claim (FR-44).
   */
  retryAttempts: number;
  nextRetryAt: Date | null;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}
