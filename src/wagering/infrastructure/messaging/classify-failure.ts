import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  MessageIdConflictError,
  TransientFailureError,
  WalletNotFoundError,
} from "../../application/errors";
import { UnprocessableMessageError } from "./wager-message";

/**
 * What to do with a message whose processing threw (REQUIREMENTS section 3.11).
 *
 * - `retry`: nothing was committed and trying again can succeed. The message is left unacknowledged and comes
 *   back when its visibility expires.
 * - `dead-letter`: the same message will fail the same way every time, so retrying only delays the verdict.
 *
 * Anything unrecognised is `retry`: a bug fixed by a deploy should find its messages still in the queue, and the
 * queue's own receive limit bounds how long a genuinely poisonous one circulates.
 */
export type FailureAction = "retry" | "dead-letter";

export function classifyFailure(error: unknown): FailureAction {
  if (error instanceof TransientFailureError) return "retry";
  if (
    error instanceof UnprocessableMessageError ||
    error instanceof InvalidRequestError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalIdConflictError ||
    error instanceof MessageIdConflictError ||
    error instanceof WalletNotFoundError
  ) {
    return "dead-letter";
  }
  return "retry";
}
