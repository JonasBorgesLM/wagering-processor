import { SettlementFailedError } from "../../application/errors";
import type { SubmissionResult } from "../../application/submit-wager-transaction";
import type { WagerTransaction } from "../../domain/wager-transaction";
import { WagerTransactionStatus as Status } from "../../domain/wager-transaction";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Each outcome of a submission has its own status, so a provider decides what to do from the status alone (§9):
 *
 * - 200 applied, or a replay of an applied one
 * - 202 accepted and waiting for the transaction it points at
 * - 422 refused by a business rule, with the reason in `failureCode`
 *
 * Errors are not here: they are thrown and mapped in one place (ADR-0012). A replay has the status of the
 * original, and says so with `idempotentReplay`.
 */
export function submissionReply(result: SubmissionResult): Reply {
  const common = {
    transactionId: result.transactionId,
    status: result.status,
    idempotentReplay: result.idempotentReplay,
  };
  const balance = result.balance ? { balance: result.balance.toJSON() } : {};

  switch (result.status) {
    case Status.Processed:
      return { status: 200, body: { ...common, ...balance } };
    case Status.PendingReference:
      return { status: 202, body: { ...common, ...balance } };
    case Status.Rejected:
      return { status: 422, body: { ...common, failureCode: result.failureCode, ...balance } };
    case Status.Failed:
      // Terminal: asking again returns this again, so it is not a 503. Escalated through the error mapping.
      throw new SettlementFailedError(`transaction ${result.transactionId} failed`);
    default:
      // A row is stored with its outcome and never PENDING (FR-31), so this is a bug and not a case.
      throw new Error(`a stored transaction was ${result.status}`);
  }
}

/** A stored transaction as a provider reads it. Fields that do not apply are absent, not null. */
export function transactionBody(t: WagerTransaction): Record<string, unknown> {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    ...(t.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: t.referenceExternalTransactionId }),
    ...(t.referenceTransactionId === undefined ? {} : { referenceTransactionId: t.referenceTransactionId }),
    status: t.status,
    ...(t.failureCode === undefined ? {} : { failureCode: t.failureCode }),
    // Absent when the response withholds it (FR-58), so a read cannot show what a submission would not.
    ...(t.observedBalance === undefined ? {} : { balance: t.observedBalance.toJSON() }),
    createdAt: t.createdAt.toISOString(),
    ...(t.processedAt === undefined ? {} : { processedAt: t.processedAt.toISOString() }),
  };
}
