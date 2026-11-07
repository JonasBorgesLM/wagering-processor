import { InvalidRequestError } from "./errors";

const VERSION = 1;
const MAX_LENGTH = 200;

/**
 * A position in a wallet's ledger, as an opaque string. Entries are ordered by
 * the wallet version, which is unique within a wallet and only ever grows, so
 * "everything after version N" gives the same answer however many entries are
 * appended while someone is paging: nothing is skipped and nothing repeats.
 *
 * Opaque, not secret: a caller who edits it just starts from another place in
 * the same wallet's ledger, which they could read from the start anyway.
 */
export function encodeLedgerCursor(afterVersion: number): string {
  return Buffer.from(JSON.stringify({ v: VERSION, after: afterVersion })).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  const invalid = () =>
    new InvalidRequestError([{ field: "cursor", reason: "is not a cursor this API issued" }]);
  // The characters are checked before decoding, because the decoder skips what it does not know: without this, one
  // cursor has many spellings ("=", "." and "!" are all ignored), and only the canonical one is ever issued.
  if (cursor.length === 0 || cursor.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid();
  const { v, after, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || v !== VERSION) throw invalid();
  if (!isPosition(after)) throw invalid();
  return after;
}

/** Exactly representable, so a cursor can never name a version that two different numbers share. */
function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
