import { disclosesBalance } from "../domain/failure-code";
import { decideSettlement } from "../domain/settlement-policy";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import { TransientFailureError } from "./errors";
import {
  type Clock,
  type IdGenerator,
  NO_METRICS,
  type PendingReferenceStore,
  type UnitOfWork,
  type WageringMetrics,
  type WaitingTransaction,
} from "./ports";
import { applyOutcome } from "./settlement-outcome";

export interface SettleWaitingOptions {
  batchSize: number;
  leaseMs: number;
  /** How long a transaction may wait for its reference before it is rejected (FR-41). */
  ttlMs: number;
  /** How long to leave a still-waiting transaction alone after its `attempts`-th look. */
  retryDelayMs(attempts: number): number;
}

export interface SettleWaitingResult {
  claimed: number;
  settled: number;
  rejected: number;
  expired: number;
  /** Still waiting: the reference has not arrived, or is itself waiting. */
  waiting: number;
  /** Already settled by another worker or by the time this one got the lock. */
  skipped: number;
  /** Could not be settled because of the infrastructure; tried again when the lease ends. */
  transientFailures: number;
  /** Could not be settled for a reason retrying cannot change (FR-32). */
  failed: number;
  /** Why each of those failed, for the log. */
  errors: unknown[];
  /** What each look ended in, for the log: ids and a status, never the amounts. */
  decisions: Array<Decision & { kind: string }>;
}

export interface Decision {
  transactionId: string;
  walletId: string;
  providerId: string;
  status: string;
  failureCode: string | undefined;
}

type Outcome = "settled" | "rejected" | "expired" | "waiting" | "skipped";
type Done = { outcome: Outcome; decision?: Decision & { kind: string } };

/**
 * Settles the transactions that arrived before their reference (FR-40 to FR-43, section 7.1), by running the same
 * settlement order as a first arrival, under the wallet lock, now that the reference may have come.
 *
 * Each transaction is its own database transaction, so one that cannot be settled does not hold back the others.
 */
export class SettleWaitingReferences {
  constructor(
    private readonly store: PendingReferenceStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: SettleWaitingOptions,
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  async runOnce(): Promise<SettleWaitingResult> {
    const claimed = await this.store.claimDue(this.options.batchSize, this.options.leaseMs, this.clock.now());
    const result: SettleWaitingResult = {
      claimed: claimed.length,
      settled: 0,
      rejected: 0,
      expired: 0,
      waiting: 0,
      skipped: 0,
      transientFailures: 0,
      failed: 0,
      errors: [],
      decisions: [],
    };

    for (const waiting of claimed) {
      try {
        const done = await this.settleOne(waiting);
        result[done.outcome] += 1;
        if (done.decision) this.record(result, done.decision);
        if (done.outcome === "waiting") this.metrics.retried("reference_worker");
      } catch (error) {
        if (error instanceof TransientFailureError) {
          // Nothing was committed. The lease it holds is its retry.
          result.transientFailures += 1;
          continue;
        }
        // A constraint or a bug: trying again cannot change the answer, so say so and stop (FR-32).
        const failed = await this.fail(waiting);
        result.failed += 1;
        result.errors.push(error);
        if (failed) this.record(result, failed);
      }
    }
    return result;
  }

  private record(result: SettleWaitingResult, decision: Decision & { kind: string }): void {
    result.decisions.push(decision);
    this.metrics.transactionDecided({
      status: decision.status,
      kind: decision.kind,
      source: "reference_worker",
    });
  }

  private settleOne(waiting: WaitingTransaction): Promise<Done> {
    return this.unitOfWork.run(async (tx) => {
      // The wallet first, as everywhere (ADR-0003). Whatever else touched it has finished by the time this returns.
      const wallet = await tx.wallets.lockById(waiting.walletId);
      const transaction = await tx.transactions.findById(waiting.id);
      if (!wallet || !transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: "skipped" };
      }

      const reference =
        transaction.referenceExternalTransactionId === undefined
          ? undefined
          : await tx.transactions.findByExternalId(
              transaction.providerId,
              transaction.referenceExternalTransactionId,
            );
      let decision = decideSettlement({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: reference ? await tx.transactions.isReversed(reference.id) : false,
      });

      const now = this.clock.now();
      let expired = false;
      if (decision.outcome === "wait-reference") {
        // Decided first, so a reference that arrived at the last moment still settles it instead of expiring it.
        if (transaction.createdAt.getTime() + this.options.ttlMs > now.getTime()) {
          await tx.transactions.scheduleRetry(
            transaction.id,
            new Date(now.getTime() + this.options.retryDelayMs(waiting.attempts)),
          );
          return { outcome: "waiting" };
        }
        expired = true;
        decision = {
          outcome: "reject",
          code: "REFERENCE_NOT_FOUND",
          observedBalance: disclosesBalance("REFERENCE_NOT_FOUND") ? wallet.balance : undefined,
        };
      }

      const events = await applyOutcome(
        tx,
        { ids: this.ids, now, correlationId: transaction.id, causationId: transaction.id },
        transaction,
        wallet,
        decision,
        "update",
      );
      await tx.outbox.enqueue(events);
      return {
        outcome: expired ? "expired" : decision.outcome === "apply" ? "settled" : "rejected",
        decision: describe(transaction),
      };
    });
  }

  /** If this cannot be recorded either, it throws, and the round ends: the lease it holds is the retry. */
  private async fail(waiting: WaitingTransaction): Promise<(Decision & { kind: string }) | undefined> {
    return this.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(waiting.walletId);
      const transaction = await tx.transactions.findById(waiting.id);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return undefined;
      transaction.fail("SETTLEMENT_FAILED");
      await tx.transactions.update(transaction);
      return describe(transaction);
    });
  }
}

function describe(transaction: WagerTransaction): Decision & { kind: string } {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    status: transaction.status,
    failureCode: transaction.failureCode,
    kind: transaction.kind,
  };
}
