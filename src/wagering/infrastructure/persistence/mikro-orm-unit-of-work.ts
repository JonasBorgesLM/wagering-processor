import { LockMode, type MikroORM, type SqlEntityManager } from "@mikro-orm/postgresql";
import { DuplicateOperationError, TransientFailureError } from "../../application/errors";
import type { Clock, TransactionContext, UnitOfWork } from "../../application/ports";
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
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);

interface DatabaseError {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
}

/** What a failed transaction means to the caller. Returns the error to throw, which may be the original. */
export function classifyPersistenceError(error: unknown): unknown {
  const { code, sqlState, constraint, message } = (error ?? {}) as DatabaseError;
  const state = typeof sqlState === "string" ? sqlState : typeof code === "string" ? code : "";
  const text = String(message ?? "");

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

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // SET LOCAL, so the limits end with this transaction and do not leak to the next user of the connection.
        await em
          .getConnection()
          .execute(
            "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
            [`${this.options.lockTimeoutMs}ms`, `${this.options.statementTimeoutMs}ms`],
            "all",
            em.getTransactionContext(),
          );
        return work(this.contextFor(em));
      });
    } catch (error) {
      throw classifyPersistenceError(error);
    }
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
      },
      ledger: {
        async append(entry) {
          await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
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
