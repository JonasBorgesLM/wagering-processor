/** A broken rule inside the domain. Business rejections are values, not errors: see SettlementPolicy. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  override readonly name = "InvalidMoneyError";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  override readonly name = "CurrencyMismatchError";
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
  override readonly name = "InvalidWalletError";
}

/** A movement the wallet can never apply: not positive, or malformed. */
export class InvalidMovementError extends DomainError {
  readonly code = "INVALID_MOVEMENT";
  override readonly name = "InvalidMovementError";
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  override readonly name = "InsufficientFundsError";
}

export class BalanceLimitExceededError extends DomainError {
  readonly code = "BALANCE_LIMIT_EXCEEDED";
  override readonly name = "BalanceLimitExceededError";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
  override readonly name = "InvalidLedgerEntryError";
}
