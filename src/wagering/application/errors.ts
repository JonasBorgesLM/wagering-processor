/** An operation the application refuses without storing anything. Each has a stable code for the API to map. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
}

/** The wallet does not exist, so there is nothing to store a rejection against (INT-12). */
export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  override readonly name = "WalletNotFoundError";
}

/** A second wallet for a player and currency that already have one (FR-10). Not a replay: creating is not idempotent. */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  override readonly name = "WalletAlreadyExistsError";
}

export interface RequestIssue {
  field: string;
  reason: string;
}

/**
 * What a caller sent cannot be acted on, and no resend of the same thing will
 * change that. It lists every problem found, so a provider fixes them in one go.
 */
export class InvalidRequestError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";
  override readonly name = "InvalidRequestError";
  constructor(readonly issues: readonly RequestIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.reason}`).join("; "));
  }
}

/** No transaction with that id, or from that provider with that external id. */
export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
  override readonly name = "TransactionNotFoundError";
}

/**
 * A stored transaction that ended in an infrastructure failure, seen by a caller who asks again. Nothing the
 * caller can change fixes it: resending the same key returns the same answer, so a new id is needed.
 */
export class SettlementFailedError extends ApplicationError {
  readonly code = "SETTLEMENT_FAILED";
  override readonly name = "SettlementFailedError";
}

/** The same key with a different payload: a different operation, never a replay (FR-53). */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  override readonly name = "IdempotencyConflictError";
}

/** The same provider operation under another key (FR-54). */
/** One message id arrived twice with different content: a broker or provider bug, never a retry (INT-17). */
export class MessageIdConflictError extends ApplicationError {
  readonly code = "MESSAGE_ID_CONFLICT";
}

export class ExternalIdConflictError extends ApplicationError {
  readonly code = "EXTERNAL_ID_CONFLICT";
  override readonly name = "ExternalIdConflictError";
}

/**
 * Nothing was committed and trying again may work: a lock wait ran out, a
 * deadlock was broken, or the database is unreachable. HTTP answers 503 and the
 * queue retries. Trying again is safe because every operation is idempotent.
 */
export class TransientFailureError extends Error {
  override readonly name = "TransientFailureError";
}

/**
 * Lost a race on a unique key: another transaction inserted this operation
 * between our check and our insert. Only possible across wallets, since the
 * wallet lock serializes everything within one. The use case starts over once,
 * and then finds the winner's row. It never leaves the application layer.
 */
export class DuplicateOperationError extends Error {
  override readonly name = "DuplicateOperationError";
}
