import { createHash } from "node:crypto";
import type { Money } from "../domain/money";
import type { WagerTransactionKind } from "../domain/wager-transaction";

/**
 * The business fields of an operation, and nothing else. The idempotency key,
 * `messageId`, `occurredAt` and any transport metadata are deliberately not
 * here: the same operation must hash the same over HTTP and over SQS, or a
 * replay arriving by the other channel would be reported as a conflict (FR-51).
 */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256, as lowercase hex, of the canonical JSON of the business fields.
 *
 * The algorithm is part of the stored data: every `payload_hash` in the
 * database was produced by it, so changing the field set, the key order or the
 * encoding makes an old row disagree with its own replay and report a false
 * conflict. A change here is a breaking change that needs a migration.
 */
export function payloadHash(input: PayloadHashInput): string {
  return createHash("sha256").update(canonicalPayload(input), "utf8").digest("hex");
}

/**
 * The exact string that is hashed: JSON with every object's keys in sorted
 * order and no whitespace. A key whose value is absent is left out, so an
 * operation without a reference and one with it unset are the same operation.
 */
export function canonicalPayload(input: PayloadHashInput): string {
  const payload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    // Through toJSON so the amount is always the fixed two-decimal string, never a bigint or a number.
    money: input.money.toJSON(),
    // Left out by canonicalJson when undefined, so an absent reference and an unset one are the same operation.
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
  return canonicalJson(payload);
}

/**
 * Only strings and plain objects are allowed. Anything else (a number, a
 * bigint, an array, `null`) has no business in this payload, and failing is
 * safer than hashing a value whose text form could differ between runtimes:
 * a float is how "25.00" would become "25".
 */
function canonicalJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`cannot canonicalize a ${typeof value} in a payload hash`);
}
