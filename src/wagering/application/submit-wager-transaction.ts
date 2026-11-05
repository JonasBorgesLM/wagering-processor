import type { FailureCode } from "../domain/failure-code";
import type { IntegrationEvent } from "../domain/integration-event";
import type { Money } from "../domain/money";
import { decideSettlement } from "../domain/settlement-policy";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/wagering-events";
import type { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import {
  DuplicateOperationError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from "./errors";
import { payloadHash } from "./payload-hash";
import type { Clock, IdGenerator, TransactionContext, UnitOfWork } from "./ports";

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
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (!(error instanceof DuplicateOperationError)) throw error;
      // Lost a race on a unique key to another wallet's transaction. The winner has committed, so this finds it.
      return this.attempt(command);
    }
  }

  private async attempt(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
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
    const context = () => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    });
    const events: Array<IntegrationEvent<object>> = [];

    switch (decision.outcome) {
      case "apply": {
        const movement = { transactionId: transaction.id, entryId: this.ids.next(), at: now };
        const entry =
          decision.direction === undefined
            ? undefined
            : decision.direction === LedgerDirection.Debit
              ? wallet.debit(transaction.money, movement)
              : wallet.credit(transaction.money, movement);
        transaction.markProcessed(decision.referenceTransactionId, wallet.balance, now);
        // The transaction first: the ledger entry's foreign key points at it.
        await tx.transactions.insert(transaction);
        events.push(WagerTransactionProcessed.from(transaction, context()));
        if (entry) {
          await tx.wallets.save(wallet);
          await tx.ledger.append(entry);
          events.push(WalletBalanceChanged.from(wallet, entry, context()));
        }
        break;
      }
      case "reject":
        transaction.reject(decision.code, decision.observedBalance);
        await tx.transactions.insert(transaction);
        events.push(WagerTransactionRejected.from(transaction, context()));
        break;
      case "wait-reference":
        transaction.markPendingReference(decision.observedBalance);
        await tx.transactions.insert(transaction);
        events.push(WagerTransactionPendingReference.from(transaction, context()));
        break;
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
