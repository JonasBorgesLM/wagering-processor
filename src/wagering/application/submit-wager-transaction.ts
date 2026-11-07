import type { FailureCode } from "../domain/failure-code";
import type { IntegrationEvent } from "../domain/integration-event";
import type { Money } from "../domain/money";
import { decideSettlement } from "../domain/settlement-policy";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import { WagerTransactionPendingReference } from "../domain/wagering-events";
import type { Wallet } from "../domain/wallet";
import {
  DuplicateOperationError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  MessageIdConflictError,
  WalletNotFoundError,
} from "./errors";
import { payloadHash } from "./payload-hash";
import {
  type Clock,
  type IdGenerator,
  NO_METRICS,
  type TransactionContext,
  type UnitOfWork,
  type WageringMetrics,
} from "./ports";
import { applyOutcome } from "./settlement-outcome";

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  causationId?: string | undefined;
}

/** Where a command came from when it arrived on a queue, so the message is recorded with its effect. */
export interface MessageSource {
  consumerName: string;
  messageId: string;
}

export interface SubmitOptions {
  /** How long a transaction that arrived before its reference waits before its first retry (FR-40, FR-41). */
  firstReferenceRetryMs: number;
}

export interface SubmissionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  /** As observed when decided, not as it is now. Absent when the response must not carry one (FR-58). */
  balance: Money | undefined;
  idempotentReplay: boolean;
}

/**
 * Settles one provider operation. HTTP and SQS both call this (§10).
 *
 * A business rejection is a normal result that commits. Everything thrown stores
 * nothing: an invalid command, a conflict, a missing wallet, a transient failure.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: SubmitOptions = { firstReferenceRetryMs: 5_000 },
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  async execute(command: SubmitWagerTransactionCommand, source?: MessageSource): Promise<SubmissionResult> {
    const origin = source ? "sqs" : "http";
    const started = performance.now();
    const timed = (outcome: "decided" | "replay" | "error") =>
      this.metrics.settlementTimed({
        source: origin,
        outcome,
        seconds: (performance.now() - started) / 1000,
      });

    let result: SubmissionResult;
    try {
      try {
        result = await this.attempt(command, source);
      } catch (error) {
        if (!(error instanceof DuplicateOperationError)) throw error;
        // Lost a race on a unique key to another wallet's transaction. The winner has committed, so this finds it.
        this.metrics.retried("duplicate_race");
        result = await this.attempt(command, source);
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.metrics.duplicateDetected("idempotency_conflict");
      else if (error instanceof ExternalIdConflictError)
        this.metrics.duplicateDetected("external_id_conflict");
      else if (error instanceof MessageIdConflictError) this.metrics.duplicateDetected("message_id_conflict");
      timed("error");
      throw error;
    }

    if (result.idempotentReplay) this.metrics.duplicateDetected("replay");
    else this.metrics.transactionDecided({ status: result.status, kind: command.kind, source: origin });
    timed(result.idempotentReplay ? "replay" : "decided");
    return result;
  }

  private async attempt(
    command: SubmitWagerTransactionCommand,
    source: MessageSource | undefined,
  ): Promise<SubmissionResult> {
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: payloadHash(command),
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    // Without the lock, so a duplicate answers at once instead of queueing behind real work on a busy wallet.
    const replay = await this.unitOfWork.run((tx) => this.answerIfKnown(tx, transaction));
    if (replay) return replay;

    return this.unitOfWork.run(async (tx) => {
      if (source) {
        const earlier = await this.recordMessage(tx, source, transaction);
        if (earlier) return earlier;
      }

      // The lock comes before any insert referencing the wallet. An insert holds FOR KEY SHARE on it through the
      // foreign key, so two transactions inserting first and locking second would deadlock (ADR-0003).
      const wallet = await tx.wallets.lockById(command.walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${command.walletId} does not exist`);

      // Again under the lock: a duplicate may have committed while this one waited.
      const known = await this.answerIfKnown(tx, transaction);
      if (known) return known;

      await this.settle(tx, transaction, wallet, command);
      return resultOf(transaction, false);
    });
  }

  /**
   * First step of a queue delivery, inside the transaction that settles it, so the message is recorded exactly
   * when its effect is and a rollback takes both. It needs no wallet lock: it references no wallet.
   * Returns the answer when this message was already processed.
   */
  private async recordMessage(
    tx: TransactionContext,
    source: MessageSource,
    transaction: WagerTransaction,
  ): Promise<SubmissionResult | undefined> {
    const seen = await tx.inbox.record({
      ...source,
      payloadHash: transaction.payloadHash,
      receivedAt: this.clock.now(),
    });
    if (seen.inserted) return undefined;
    if (seen.payloadHash !== transaction.payloadHash) {
      throw new MessageIdConflictError(`message ${source.messageId} was seen before with different content`);
    }
    const known = await this.answerIfKnown(tx, transaction);
    // The inbox row and the transaction commit together, so a recorded message always has its transaction.
    if (!known) throw new Error(`message ${source.messageId} is recorded but has no transaction`);
    return known;
  }

  /**
   * Two reads are not one snapshot: a twin can commit between them. So this asks what the row it found IS, not
   * which of the two lookups found it. A row under our own key is a replay (or a conflict, if the payload
   * differs) however it was reached; only a row under another key is the same operation sent twice.
   * Reporting it by the lookup that found it called a replay a conflict: 13 of 600 identical requests, in 8 of 12
   * rounds of fifty spread over three processes.
   */
  private async answerIfKnown(
    tx: TransactionContext,
    transaction: WagerTransaction,
  ): Promise<SubmissionResult | undefined> {
    const existing =
      (await tx.transactions.findByKey(transaction.idempotencyKey)) ??
      (await tx.transactions.findByExternalId(transaction.providerId, transaction.externalTransactionId));
    if (!existing) return undefined;

    if (existing.idempotencyKey !== transaction.idempotencyKey) {
      throw new ExternalIdConflictError(
        `${transaction.providerId}:${transaction.externalTransactionId} already exists under another key`,
      );
    }
    if (!existing.matchesPayload(transaction.payloadHash)) {
      throw new IdempotencyConflictError(
        `key ${transaction.idempotencyKey} was used with a different payload`,
      );
    }
    return resultOf(existing, true);
  }

  private async settle(
    tx: TransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    command: SubmitWagerTransactionCommand,
  ): Promise<void> {
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await tx.transactions.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
    const decision = decideSettlement({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: reference ? await tx.transactions.isReversed(reference.id) : false,
    });

    const now = this.clock.now();
    const outcome = {
      ids: this.ids,
      now,
      correlationId: command.correlationId,
      causationId: command.causationId,
    };
    let events: Array<IntegrationEvent<object>>;

    if (decision.outcome === "wait-reference") {
      transaction.markPendingReference(decision.observedBalance);
      await tx.transactions.insert(transaction);
      await tx.transactions.scheduleRetry(
        transaction.id,
        new Date(now.getTime() + this.options.firstReferenceRetryMs),
      );
      events = [
        WagerTransactionPendingReference.from(transaction, {
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          causationId: command.causationId,
          occurredAt: now,
        }),
      ];
    } else {
      events = await applyOutcome(tx, outcome, transaction, wallet, decision, "insert");
    }
    await tx.outbox.enqueue(events);
  }
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): SubmissionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.observedBalance,
    idempotentReplay,
  };
}
