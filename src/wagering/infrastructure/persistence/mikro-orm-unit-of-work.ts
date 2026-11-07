import { LockMode, type MikroORM, type SqlEntityManager } from "@mikro-orm/postgresql";
import {
  DuplicateOperationError,
  TransientFailureError,
  WalletAlreadyExistsError,
} from "../../application/errors";
import type { Clock, TransactionContext, TransientReason, UnitOfWork } from "../../application/ports";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";
import {
  ledgerEntryToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "./mappers";
import { LedgerEntrySchema, WagerTransactionSchema, WalletSchema } from "./schemas";

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** Told of every transient failure, so lock conflicts and the rest can be counted wherever they happen (NFR-06). */
  onTransientFailure?: (reason: TransientReason) => void;
}

/** The unique keys that mean "this operation already exists". Any other violation is a bug and must stay loud. */
const OPERATION_KEYS = ["uq_wager_transactions_idempotency_key", "uq_wager_transactions_provider_external"];

/**
 * lock_not_available, deadlock_detected, serialization_failure, query_canceled
 * and the shutdown and connection classes: nothing committed, and trying again
 * may work. A constraint violation is deliberately not here: retrying cannot
 * change its answer.
 */
const TRANSIENT_SQLSTATES = new Set(["55P03", "40P01", "40001", "57014", "57P01", "57P02", "57P03", "53300"]);
const TRANSIENT_SQLSTATE_CLASS = "08";
export const POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";
/**
 * What the client reports when a connection it was opening, or one it had, is gone: "Connection terminated due to
 * connection timeout" when opening one took longer than the connection timeout, and "Connection terminated
 * unexpectedly" when the server closed it. Both are bare errors with no code, so the message is all there is.
 */
export const CONNECTION_TERMINATED_MESSAGE = "Connection terminated";
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);

interface DatabaseError {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
}

/** Why a transient failure was transient, as a label that stays within a closed set. */
export function transientReason(error: unknown): TransientReason {
  const { code, sqlState, message } = (error ?? {}) as DatabaseError;
  const state = typeof sqlState === "string" ? sqlState : typeof code === "string" ? code : "";
  if (String(message ?? "").includes(POOL_TIMEOUT_MESSAGE)) return "pool_timeout";
  if (String(message ?? "").includes(CONNECTION_TERMINATED_MESSAGE)) return "connection";
  if (state === "55P03") return "lock_timeout";
  if (state === "40P01") return "deadlock";
  if (state === "40001") return "serialization_failure";
  if (state === "57014") return "statement_timeout";
  if (
    state.startsWith(TRANSIENT_SQLSTATE_CLASS) ||
    TRANSIENT_NETWORK_CODES.has(state) ||
    state.startsWith("57P")
  ) {
    return "connection";
  }
  return "other";
}

/** What a failed transaction means to the caller. Returns the error to throw, which may be the original. */
export function classifyPersistenceError(error: unknown): unknown {
  const { code, sqlState, constraint, message } = (error ?? {}) as DatabaseError;
  const state = typeof sqlState === "string" ? sqlState : typeof code === "string" ? code : "";
  const text = String(message ?? "");

  // pg-pool reports a full pool with a bare Error and no code, so the message is all there is to go on. A test
  // provokes the real error, so an upgrade that rewords it fails there and not silently in production.
  if (text.includes(POOL_TIMEOUT_MESSAGE)) {
    return new TransientFailureError("no database connection became free in time", { cause: error });
  }
  if (text.includes(CONNECTION_TERMINATED_MESSAGE)) {
    return new TransientFailureError("database connection lost or too slow to open", { cause: error });
  }
  if (
    state === "23505" &&
    (constraint === "uq_wallets_player_currency" || text.includes('"uq_wallets_player_currency"'))
  ) {
    return new WalletAlreadyExistsError(text);
  }
  if (state === "23505" && OPERATION_KEYS.some((key) => key === constraint || text.includes(`"${key}"`))) {
    return new DuplicateOperationError(text);
  }
  if (
    TRANSIENT_SQLSTATES.has(state) ||
    state.startsWith(TRANSIENT_SQLSTATE_CLASS) ||
    TRANSIENT_NETWORK_CODES.has(state)
  ) {
    return new TransientFailureError(`transient database failure (${state})`, { cause: error });
  }
  return error;
}

/**
 * One database transaction with its limits set and its failures classified. The
 * limits are `SET LOCAL`, so they end with the transaction and do not leak to
 * the connection's next user. Shared by writes and reads, since a read waiting
 * forever holds a connection just as a write does (NFR-11).
 */
export async function boundedTransaction<T>(
  orm: MikroORM,
  options: UnitOfWorkOptions,
  work: (em: SqlEntityManager) => Promise<T>,
): Promise<T> {
  try {
    return await orm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
          [`${options.lockTimeoutMs}ms`, `${options.statementTimeoutMs}ms`],
          "all",
          em.getTransactionContext(),
        );
      return await work(em);
    });
  } catch (error) {
    const classified = classifyPersistenceError(error);
    if (classified instanceof TransientFailureError) {
      try {
        options.onTransientFailure?.(transientReason(error));
      } catch {
        // Counting must never change what the caller sees.
      }
    }
    throw classified;
  }
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly options: UnitOfWorkOptions,
  ) {}

  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return boundedTransaction(this.orm, this.options, (em) => work(this.contextFor(em)));
  }

  // Reads skip the identity map and writes are explicit statements, so the ORM's unit of work never flushes
  // anything implicitly: what reaches the database is exactly what these methods say (ADR-0002).
  private contextFor(em: SqlEntityManager): TransactionContext {
    const clock = this.clock;
    return {
      wallets: {
        async lockById(id) {
          const record = await em.findOne(
            WalletSchema,
            { id },
            { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
          );
          return record ? walletFromRecord(record) : undefined;
        },
        async insert(wallet) {
          await em.insert(WalletSchema, walletToRecord(wallet));
        },
        async save(wallet) {
          const { balance, version, updatedAt } = walletToRecord(wallet);
          await em.nativeUpdate(WalletSchema, { id: wallet.id }, { balance, version, updatedAt });
        },
      },
      transactions: {
        async findByKey(idempotencyKey) {
          const record = await em.findOne(
            WagerTransactionSchema,
            { idempotencyKey },
            { disableIdentityMap: true },
          );
          return record ? transactionFromRecord(record) : undefined;
        },
        async findByExternalId(providerId, externalTransactionId) {
          const record = await em.findOne(
            WagerTransactionSchema,
            { providerId, externalTransactionId },
            { disableIdentityMap: true },
          );
          return record ? transactionFromRecord(record) : undefined;
        },
        async isReversed(referenceTransactionId) {
          // Only a processed row can hold a link (ck_wager_transactions_reference_link), so the status changes no
          // answer here. It is stated so the query matches the predicate of the partial unique index.
          const reversals = await em.count(WagerTransactionSchema, {
            referenceTransactionId,
            kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
            status: WagerTransactionStatus.Processed,
          });
          return reversals > 0;
        },
        async insert(transaction) {
          await em.insert(WagerTransactionSchema, transactionToRecord(transaction, clock.now()));
        },
        async findById(id) {
          const record = await em.findOne(WagerTransactionSchema, { id }, { disableIdentityMap: true });
          return record ? transactionFromRecord(record) : undefined;
        },
        async update(transaction) {
          const record = transactionToRecord(transaction, clock.now());
          // Only what a settlement changes. The identity of the operation is immutable, and the schedule ends here.
          await em.getConnection().execute(
            `update wager_transactions
                  set status = ?, failure_code = ?, observed_balance = ?, processed_at = ?,
                      reference_transaction_id = ?, updated_at = ?, next_retry_at = null
                where id = ?`,
            [
              record.status,
              record.failureCode,
              record.observedBalance,
              record.processedAt,
              record.referenceTransactionId,
              record.updatedAt,
              record.id,
            ],
            "run",
            em.getTransactionContext(),
          );
        },
        async scheduleRetry(id, nextRetryAt) {
          await em
            .getConnection()
            .execute(
              "update wager_transactions set next_retry_at = ?, updated_at = ? where id = ? and status = 'PENDING_REFERENCE'",
              [nextRetryAt, clock.now(), id],
              "run",
              em.getTransactionContext(),
            );
        },
      },
      ledger: {
        async append(entry) {
          await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
        },
      },
      inbox: {
        async record(message) {
          const connection = em.getConnection();
          const inserted = (await connection.execute(
            "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at) values (?, ?, ?, ?, ?) on conflict do nothing returning message_id",
            [
              message.consumerName,
              message.messageId,
              message.payloadHash,
              message.receivedAt,
              message.receivedAt,
            ],
            "all",
            em.getTransactionContext(),
          )) as unknown[];
          if (inserted.length > 0) return { inserted: true };
          const [row] = (await connection.execute(
            "select payload_hash from inbox_messages where consumer_name = ? and message_id = ?",
            [message.consumerName, message.messageId],
            "all",
            em.getTransactionContext(),
          )) as Array<{ payload_hash: string }>;
          if (!row) throw new Error("inbox row vanished after a conflict");
          return { inserted: false, payloadHash: row.payload_hash };
        },
      },
      outbox: {
        async enqueue(events) {
          for (const event of events) {
            await em
              .getConnection()
              .execute(
                "insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at) values (?, ?, ?, ?::jsonb, ?, ?)",
                [
                  event.eventId,
                  event.aggregateId,
                  event.eventType,
                  JSON.stringify(event),
                  event.occurredAt,
                  event.occurredAt,
                ],
                "run",
                em.getTransactionContext(),
              );
          }
        },
      },
    };
  }
}
