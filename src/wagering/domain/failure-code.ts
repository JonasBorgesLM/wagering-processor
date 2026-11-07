/**
 * Stable, machine-readable reasons, so a provider can decide whether to resend,
 * fix the payload, or give up without parsing a message (§7.2).
 *
 * Only codes that are stored on a transaction live here. Codes for operations
 * that never become a row (WALLET_NOT_FOUND, IDEMPOTENCY_CONFLICT,
 * EXTERNAL_ID_CONFLICT, VALIDATION_ERROR) belong to the API and are not part of
 * the domain's state. See REQUIREMENTS section 3.8.
 */
export const REJECTION_CODES = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_INSUFFICIENT_FUNDS",
  "CURRENCY_MISMATCH",
  "PLAYER_WALLET_MISMATCH",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_KIND_NOT_ALLOWED",
  "REFERENCE_NOT_PROCESSED",
  "REFERENCE_AMOUNT_MISMATCH",
  "ALREADY_REVERSED",
  "BALANCE_LIMIT_EXCEEDED",
] as const;

/** A business rule refused the transaction. The provider's payload or the wallet's state is the cause. */
export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * Kept apart from rejections on purpose: reusing a business code would tell the
 * provider that its payload is wrong when our infrastructure failed (INT-20).
 */
export const INFRASTRUCTURE_FAILURE_CODES = ["SETTLEMENT_FAILED"] as const;

export type InfrastructureFailureCode = (typeof INFRASTRUCTURE_FAILURE_CODES)[number];

export type FailureCode = RejectionCode | InfrastructureFailureCode;

export function isRejectionCode(value: unknown): value is RejectionCode {
  return (REJECTION_CODES as readonly unknown[]).includes(value);
}

export function isInfrastructureFailureCode(value: unknown): value is InfrastructureFailureCode {
  return (INFRASTRUCTURE_FAILURE_CODES as readonly unknown[]).includes(value);
}

/**
 * Rejections whose response must not carry a balance (FR-58). A wallet that
 * belongs to someone else must not leak its balance, and a balance in another
 * currency cannot be recorded against a transaction in this one.
 */
const WITHOUT_BALANCE: readonly RejectionCode[] = ["PLAYER_WALLET_MISMATCH", "CURRENCY_MISMATCH"];

export function disclosesBalance(code: RejectionCode): boolean {
  return !WITHOUT_BALANCE.includes(code);
}
