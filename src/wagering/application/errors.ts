/** An operation the application refuses without storing anything. Each has a stable code for the API to map. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
}

/** The wallet does not exist, so there is nothing to store a rejection against (INT-12). */
export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  override readonly name = "WalletNotFoundError";
}

/** The same key with a different payload: a different operation, never a replay (FR-53). */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  override readonly name = "IdempotencyConflictError";
}

/** The same provider operation under another key (FR-54). */
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
