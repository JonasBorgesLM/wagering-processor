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
