import { InvalidRequestError, type RequestIssue } from "../../application/errors";
import { DomainError } from "../../domain/errors";
import { Money } from "../../domain/money";

// The edge of the system: nothing here trusts its input. Each parser collects every problem it finds and
// throws once, so a provider fixes a bad request in one round trip and not one field at a time.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Issues {
  readonly list: RequestIssue[] = [];

  add(field: string, reason: string): void {
    this.list.push({ field, reason });
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new InvalidRequestError(this.list);
  }
}

/** A UUID in any case, returned in lowercase: PostgreSQL stores it that way, and ids are compared as text (INT-25). */
export function parseUuid(value: unknown, field: string, issues: Issues): string | undefined {
  if (typeof value !== "string" || !UUID.test(value)) {
    issues.add(field, "must be a UUID");
    return undefined;
  }
  return value.toLowerCase();
}

/** A JSON object with exactly the named keys: a missing one is reported, and so is an unknown one (INT-25). */
export function exactObject(
  value: unknown,
  field: string,
  keys: readonly string[],
  issues: Issues,
): Record<string, unknown> | undefined {
  // The body itself has no field name of its own, and a caller cannot act on an empty one.
  const prefix = field === "" ? "" : `${field}.`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.add(field === "" ? "body" : field, "must be a JSON object");
    return undefined;
  }
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in object)) issues.add(`${prefix}${key}`, "is required");
  }
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) issues.add(`${prefix}${key}`, "is not a known field");
  }
  return object;
}

export function parseMoney(value: unknown, field: string, issues: Issues): Money | undefined {
  const object = exactObject(value, field, ["amount", "currency"], issues);
  if (!object || typeof object.amount === "undefined" || typeof object.currency === "undefined")
    return undefined;
  try {
    return Money.from({ amount: object.amount as string, currency: object.currency as string });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    issues.add(field, error.message);
    return undefined;
  }
}

export interface OpenWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export function parseOpenWalletBody(body: unknown): OpenWalletRequest {
  const issues = new Issues();
  const object = exactObject(body, "", ["playerId", "initialBalance"], issues);
  const playerId =
    object && "playerId" in object ? parseUuid(object.playerId, "playerId", issues) : undefined;
  const initialBalance =
    object && "initialBalance" in object
      ? parseMoney(object.initialBalance, "initialBalance", issues)
      : undefined;
  issues.throwIfAny();
  return { playerId: playerId as string, initialBalance: initialBalance as Money };
}

export function parseWalletId(value: unknown): string {
  const issues = new Issues();
  const id = parseUuid(value, "walletId", issues);
  issues.throwIfAny();
  return id as string;
}

/** Whole numbers only: "10abc", "1e2", "-1" and " 5" are not numbers here, and a long digit string cannot lose precision. */
export function parseLedgerQuery(query: unknown): { cursor?: string; limit?: number } {
  const issues = new Issues();
  const source = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  const result: { cursor?: string; limit?: number } = {};

  if (source.cursor !== undefined) {
    if (typeof source.cursor !== "string" || source.cursor === "")
      issues.add("cursor", "must be given once, and not empty");
    else result.cursor = source.cursor;
  }
  if (source.limit !== undefined) {
    if (typeof source.limit !== "string" || !/^[0-9]{1,9}$/.test(source.limit))
      issues.add("limit", "must be a whole number");
    else result.limit = Number(source.limit); // money-check: not-money a page size, at most nine digits
  }
  issues.throwIfAny();
  return result;
}
