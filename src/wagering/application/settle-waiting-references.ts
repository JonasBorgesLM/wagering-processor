import { disclosesBalance } from "../domain/failure-code";
import { decideSettlement } from "../domain/settlement-policy";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { TransientFailureError } from "./errors";
import type { Clock, IdGenerator, PendingReferenceStore, UnitOfWork, WaitingTransaction } from "./ports";
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
}

type Outcome = "settled" | "rejected" | "expired" | "waiting" | "skipped";

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
    };

    for (const waiting of claimed) {
      try {
        result[await this.settleOne(waiting)] += 1;
      } catch (error) {
        if (error instanceof TransientFailureError) {
          // Nothing was committed. The lease it holds is its retry.
          result.transientFailures += 1;
          continue;
        }
        // A constraint or a bug: trying again cannot change the answer, so say so and stop (FR-32).
        await this.fail(waiting);
        result.failed += 1;
        result.errors.push(error);
      }
    }
    return result;
  }

  private settleOne(waiting: WaitingTransaction): Promise<Outcome> {
    return this.unitOfWork.run(async (tx) => {
      // The wallet first, as everywhere (ADR-0003). Whatever else touched it has finished by the time this returns.
      const wallet = await tx.wallets.lockById(waiting.walletId);
      const transaction = await tx.transactions.findById(waiting.id);
      if (!wallet || !transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return "skipped";
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
          return "waiting";
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
      return expired ? "expired" : decision.outcome === "apply" ? "settled" : "rejected";
    });
  }

  /** If this cannot be recorded either, it throws, and the round ends: the lease it holds is the retry. */
  private async fail(waiting: WaitingTransaction): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(waiting.walletId);
      const transaction = await tx.transactions.findById(waiting.id);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return;
      transaction.fail("SETTLEMENT_FAILED");
      await tx.transactions.update(transaction);
    });
  }
}
