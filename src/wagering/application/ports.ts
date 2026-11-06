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
  /** Deduplication of queue messages by `(consumerName, messageId)`, written with the effect it guards (NFR-04). */
  inbox: {
    /**
     * Records the message, or says it was already recorded and with which hash. Waits for a concurrent insert of
     * the same message to finish, so two deliveries at once cannot both be new.
     */
    record(message: InboxMessage): Promise<{ inserted: true } | { inserted: false; payloadHash: string }>;
  };
  outbox: {
    enqueue(events: ReadonlyArray<IntegrationEvent<object>>): Promise<void>;
  };
}

export interface InboxMessage {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
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

/** One row of the outbox that a publisher has claimed (FR-90, ADR-0007). */
export interface OutboxEntry {
  id: string;
  eventType: string;
  aggregateId: string;
  /** The event's envelope, as stored. */
  payload: object;
  /** How many times it has been claimed, this claim included. */
  attempts: number;
}

export interface OutboxStore {
  /**
   * Claims up to `limit` due rows in one short transaction, and pushes each row's `next_attempt_at` forward by the
   * lease before committing. A row claimed here is invisible to every other publisher until the lease runs out, so
   * nothing is held while publishing, and a publisher that dies hands its rows on by itself.
   */
  claimDue(limit: number, leaseMs: number, now: Date): Promise<OutboxEntry[]>;
  markPublished(id: string, at: Date): Promise<void>;
  /** Puts a row back for a later attempt. Nothing is ever given up on (FR-91). */
  reschedule(id: string, nextAttemptAt: Date): Promise<void>;
}

/** Sends an event to the broker. Resolves only when the broker has accepted it. */
export interface EventPublisher {
  publish(entry: OutboxEntry): Promise<void>;
}
