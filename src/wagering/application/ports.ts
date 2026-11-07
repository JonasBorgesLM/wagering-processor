import type { IntegrationEvent } from "../domain/integration-event";
import type { Money } from "../domain/money";
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
    findById(id: string): Promise<WagerTransaction | undefined>;
    /**
     * Writes the outcome of a transaction that was waiting for its reference, and ends its schedule. The row was
     * inserted earlier; only the fields a settlement changes are written.
     */
    update(transaction: WagerTransaction): Promise<void>;
    /** When a transaction that is waiting for its reference should be looked at again (FR-40). */
    scheduleRetry(id: string, nextRetryAt: Date): Promise<void>;
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
  /** Marks rows published, in one statement. Rows already published are left alone. */
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  /** Puts rows back for a later attempt, each at its own time, in one statement. Nothing is ever given up on (FR-91). */
  reschedule(items: ReadonlyArray<{ id: string; nextAttemptAt: Date }>): Promise<void>;
}

export interface PublishBatchResult {
  /** Ids of the entries the broker accepted. */
  accepted: string[];
  /** Entries it refused, with why. A call that fails as a whole throws instead, and means all of them. */
  rejected: Array<{ id: string; error: unknown }>;
}

/**
 * Sends events to the broker, a few per call. Resolves only for what the broker accepted. The entries of one call are
 * sent in order, so a wallet's events within a call keep theirs; across calls, the caller keeps a wallet's events in
 * one sequence (`planLanes`).
 */
export interface EventPublisher {
  /** At most `MAX_PUBLISH_BATCH` entries. Throws if the call as a whole failed. */
  publishBatch(entries: readonly OutboxEntry[]): Promise<PublishBatchResult>;
}

/** What the broker accepts in one call. */
export const MAX_PUBLISH_BATCH = 10;

/** A transaction a worker has claimed because it was waiting for its reference and is due. */
export interface WaitingTransaction {
  id: string;
  walletId: string;
  /** Claims so far, this one included. */
  attempts: number;
}

export interface PendingReferenceStore {
  /**
   * Claims up to `limit` due waiting transactions, oldest first, and pushes each one's `next_retry_at` forward by the
   * lease in the same statement. Like the outbox, nothing is held afterwards: a worker that dies hands its rows on
   * when the lease ends.
   */
  claimDue(limit: number, leaseMs: number, now: Date): Promise<WaitingTransaction[]>;
}

export type LedgerIssueKind = "ENTRY_UNBALANCED" | "CHAIN_BROKEN" | "CURRENCY_MISMATCH";

export interface LedgerIssue {
  walletVersion: number;
  kind: LedgerIssueKind;
}

/** One wallet and its whole ledger, read as of a single instant (FR-71). */
export interface LedgerSnapshot {
  storedBalance: Money;
  credits: Money;
  debits: Money;
  checkedEntries: number;
  /** All the entries with a problem, though `issues` holds only the first few. */
  issueCount: number;
  issues: LedgerIssue[];
}

export interface ReconciliationReader {
  /** Takes no lock. One consistent snapshot of the wallet and its entries, or `undefined` for no such wallet. */
  snapshot(walletId: string): Promise<LedgerSnapshot | undefined>;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** Stored minus calculated, signed: positive when the wallet holds more than its ledger explains. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  issueCount: number;
  issues: LedgerIssue[];
}

/** Where a divergence is made visible (FR-72). The report itself is the response; this is the log and the metric. */
export interface DivergenceReporter {
  checked(report: ReconciliationReport): void;
}

export type DuplicateKind =
  | "replay"
  | "idempotency_conflict"
  | "external_id_conflict"
  | "message_id_conflict";
export type RetryComponent = "consumer" | "outbox" | "reference_worker" | "duplicate_race";
export type DeadLetterReason = "permanent" | "attempts-exhausted";
export type TransientReason =
  | "lock_timeout"
  | "deadlock"
  | "serialization_failure"
  | "statement_timeout"
  | "pool_timeout"
  | "connection"
  | "other";

/**
 * What the system counts (NFR-06). Every method is a fact that already happened and returns nothing: a metric never
 * decides anything, and one that fails must not fail what it measures. Labels are a closed set on purpose: a value
 * from a request (a wallet, a provider, a key) would make the series unbounded.
 */
export interface WageringMetrics {
  /** A transaction reached a status by a decision: a first arrival or a worker's look. Replays are not decisions. */
  transactionDecided(event: {
    status: string;
    kind: string;
    source: "http" | "sqs" | "reference_worker";
  }): void;
  duplicateDetected(kind: DuplicateKind): void;
  retried(component: RetryComponent): void;
  deadLettered(reason: DeadLetterReason): void;
  /** A database call failed in a way trying again may fix. Lock timeouts and deadlocks are the lock conflicts. */
  databaseTransient(reason: TransientReason): void;
  /** How long one settlement took, from the use case's first line to its return or throw. */
  settlementTimed(event: {
    source: "http" | "sqs";
    outcome: "decided" | "replay" | "error";
    seconds: number;
  }): void;
}

export const NO_METRICS: WageringMetrics = {
  transactionDecided: () => undefined,
  duplicateDetected: () => undefined,
  retried: () => undefined,
  deadLettered: () => undefined,
  databaseTransient: () => undefined,
  settlementTimed: () => undefined,
};
