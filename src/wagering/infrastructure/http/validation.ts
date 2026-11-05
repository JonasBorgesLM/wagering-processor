import { InvalidRequestError, type RequestIssue } from "../../application/errors";
import { DomainError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { INTERNAL_PROVIDER_ID, WagerTransactionKind } from "../../domain/wager-transaction";

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

/**
 * A JSON object with exactly the named keys: a missing required one is reported, and so is an unknown one (INT-25).
 * `optional` keys may be present or absent.
 */
export function exactObject(
  value: unknown,
  field: string,
  keys: readonly string[],
  issues: Issues,
  optional: readonly string[] = [],
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
    if (!keys.includes(key) && !optional.includes(key)) issues.add(`${prefix}${key}`, "is not a known field");
  }
  return object;
}

const TEXT_MAX = 255;
// NUL in particular: PostgreSQL refuses it in text, and the refusal would otherwise surface as a 500.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** An opaque id or key from a provider: bounded by its column, and free of control characters (SR-04). */
export function parseText(value: unknown, field: string, issues: Issues): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.add(field, "must be a non-empty string");
    return undefined;
  }
  if (value.length > TEXT_MAX) {
    issues.add(field, `must be at most ${TEXT_MAX} characters`);
    return undefined;
  }
  if (CONTROL_CHARACTER.test(value)) {
    issues.add(field, "must not contain control characters");
    return undefined;
  }
  return value;
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

export interface SubmitRequest {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

const SUBMITTABLE: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/**
 * The header is the source of truth for idempotency (FR-50). The rules about kind, amount and reference are the
 * domain's too; they are repeated here so the provider is told which field to fix, and a test checks the two
 * never disagree.
 */
export function parseSubmitTransaction(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): SubmitRequest {
  const issues = new Issues();

  const header = headers["idempotency-key"];
  const idempotencyKey =
    header === undefined
      ? undefined
      : typeof header === "string"
        ? parseText(header, "Idempotency-Key", issues)
        : undefined;
  if (header === undefined) issues.add("Idempotency-Key", "is required");
  else if (typeof header !== "string") issues.add("Idempotency-Key", "must be given once");

  const object = exactObject(
    body,
    "",
    ["providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money"],
    issues,
    ["referenceExternalTransactionId"],
  );
  const get = (key: string) => (object && key in object ? object[key] : undefined);

  let providerId =
    object && "providerId" in object ? parseText(object.providerId, "providerId", issues) : undefined;
  if (providerId === INTERNAL_PROVIDER_ID) {
    issues.add("providerId", `"${INTERNAL_PROVIDER_ID}" is reserved`);
    providerId = undefined;
  }
  const externalTransactionId =
    object && "externalTransactionId" in object
      ? parseText(object.externalTransactionId, "externalTransactionId", issues)
      : undefined;
  const playerId =
    object && "playerId" in object ? parseUuid(object.playerId, "playerId", issues) : undefined;
  const walletId =
    object && "walletId" in object ? parseUuid(object.walletId, "walletId", issues) : undefined;
  const roundId = object && "roundId" in object ? parseText(object.roundId, "roundId", issues) : undefined;
  const gameId = object && "gameId" in object ? parseText(object.gameId, "gameId", issues) : undefined;

  let kind: WagerTransactionKind | undefined;
  if (object && "kind" in object) {
    if (object.kind === WagerTransactionKind.Opening)
      issues.add("kind", "OPENING is internal and cannot be submitted");
    else if (typeof object.kind !== "string" || !SUBMITTABLE.includes(object.kind)) {
      issues.add("kind", `must be one of ${SUBMITTABLE.join(", ")}`);
    } else kind = object.kind as WagerTransactionKind;
  }

  const money = object && "money" in object ? parseMoney(object.money, "money", issues) : undefined;
  if (kind && money?.isZero() && kind !== WagerTransactionKind.Loss) {
    issues.add("money", `must be greater than zero for a ${kind}`);
  }

  const reference = get("referenceExternalTransactionId");
  const referenceExternalTransactionId =
    reference === undefined ? undefined : parseText(reference, "referenceExternalTransactionId", issues);
  if (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) {
    if (reference === undefined) issues.add("referenceExternalTransactionId", `is required for a ${kind}`);
  } else if (kind === WagerTransactionKind.Bet && reference !== undefined) {
    issues.add("referenceExternalTransactionId", "is not allowed for a BET");
  }
  if (
    referenceExternalTransactionId !== undefined &&
    referenceExternalTransactionId === externalTransactionId
  ) {
    issues.add("referenceExternalTransactionId", "cannot be the transaction itself");
  }

  issues.throwIfAny();
  return {
    idempotencyKey: idempotencyKey as string,
    providerId: providerId as string,
    externalTransactionId: externalTransactionId as string,
    playerId: playerId as string,
    walletId: walletId as string,
    roundId: roundId as string,
    gameId: gameId as string,
    kind: kind as WagerTransactionKind,
    money: money as Money,
    referenceExternalTransactionId,
  };
}

export function parseTransactionId(value: unknown): string {
  const issues = new Issues();
  const id = parseUuid(value, "transactionId", issues);
  issues.throwIfAny();
  return id as string;
}

export function parseProviderTransactionPath(providerId: unknown, externalTransactionId: unknown) {
  const issues = new Issues();
  const provider = parseText(providerId, "providerId", issues);
  const external = parseText(externalTransactionId, "externalTransactionId", issues);
  issues.throwIfAny();
  return { providerId: provider as string, externalTransactionId: external as string };
}
