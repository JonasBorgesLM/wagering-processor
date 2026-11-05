import type { IntegrationEvent } from "../domain/integration-event";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

/**
 * One SQL transaction. Repositories exist only inside `run`, so a write outside
 * the transaction cannot be written. It commits when `work` returns and rolls
 * back when it throws.
 */
export interface UnitOfWork {
  /** Throws `TransientFailureError` and `DuplicateOperationError` as described on each. */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TransactionContext {
  wallets: {
    /** Takes the row lock, and waits for it within the lock timeout (ADR-0003). */
    lockById(id: string): Promise<Wallet | undefined>;
    insert(wallet: Wallet): Promise<void>;
    save(wallet: Wallet): Promise<void>;
  };
  transactions: {
    findByKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
    findByExternalId(
      providerId: string,
      externalTransactionId: string,
    ): Promise<WagerTransaction | undefined>;
    /** Whether a `PROCESSED` reversal already points at this transaction (ADR-0006). */
    isReversed(referenceTransactionId: string): Promise<boolean>;
    insert(transaction: WagerTransaction): Promise<void>;
  };
  ledger: {
    /** Append only: the port offers nothing else, and the database refuses anything else (SR-06). */
    append(entry: WalletLedgerEntry): Promise<void>;
  };
  outbox: {
    enqueue(events: ReadonlyArray<IntegrationEvent<object>>): Promise<void>;
  };
}

/** Reads of stored transactions, with no lock. Committed state only. */
export interface TransactionReader {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}

/** Reads that take no lock and change nothing. Committed state only. */
export interface WalletReader {
  findWallet(id: string): Promise<Wallet | undefined>;
  /** Entries after the given wallet version, oldest first. Ordered by a column that never repeats within a wallet. */
  ledgerAfter(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
