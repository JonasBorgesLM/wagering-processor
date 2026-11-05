import { describe, expect, test } from "bun:test";
import { InvalidRequestError, type RequestIssue } from "../../../src/wagering/application/errors";
import {
  parseLedgerQuery,
  parseOpenWalletBody,
  parseWalletId,
} from "../../../src/wagering/infrastructure/http/validation";

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const valid = { playerId: PLAYER, initialBalance: { amount: "1000.00", currency: "BRL" } };

function issuesOf(attempt: () => unknown): RequestIssue[] {
  try {
    attempt();
  } catch (error) {
    if (error instanceof InvalidRequestError) return [...error.issues];
    throw error;
  }
  throw new Error("expected the request to be refused");
}
const fields = (attempt: () => unknown) =>
  issuesOf(attempt)
    .map((issue) => issue.field)
    .sort();

describe("a valid wallet request", () => {
  test("is accepted, with the money parsed", () => {
    const request = parseOpenWalletBody(valid);
    expect(request.playerId).toBe(PLAYER);
    expect(request.initialBalance.toString()).toBe("1000.00 BRL");
  });

  test("a zero balance is valid (FR-12)", () => {
    expect(
      parseOpenWalletBody({
        ...valid,
        initialBalance: { amount: "0.00", currency: "BRL" },
      }).initialBalance.isZero(),
    ).toBe(true);
  });

  // INT-25: ids are compared as text, and PostgreSQL stores a UUID in lowercase.
  test("an uppercase player id is normalized to lowercase", () => {
    expect(parseOpenWalletBody({ ...valid, playerId: PLAYER.toUpperCase() }).playerId).toBe(PLAYER);
  });
});

describe("a body that is not a JSON object", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", [valid]],
    ["a string", "playerId"],
    ["a number", 7],
    ["a boolean", true],
  ])("%s", (_name, body) => {
    expect(issuesOf(() => parseOpenWalletBody(body))).toEqual([
      { field: "body", reason: "must be a JSON object" },
    ]);
  });
});

describe("the fields", () => {
  test("missing ones are all reported", () => {
    expect(fields(() => parseOpenWalletBody({}))).toEqual(["initialBalance", "playerId"]);
  });

  test("an unknown field is refused, so a typo is not silently dropped (INT-25)", () => {
    expect(issuesOf(() => parseOpenWalletBody({ ...valid, initialBalence: 1 }))).toContainEqual({
      field: "initialBalence",
      reason: "is not a known field",
    });
  });

  test.each([
    ["not a UUID", "player-1"],
    ["empty", ""],
    ["a number", 7],
    ["null", null],
    ["a UUID with a character too many", `${PLAYER}0`],
    ["a UUID without hyphens", PLAYER.replaceAll("-", "")],
    ["a UUID with braces", `{${PLAYER}}`],
    ["a UUID with a trailing newline", `${PLAYER}\n`],
  ])("playerId that is %s", (_name, playerId) => {
    expect(fields(() => parseOpenWalletBody({ ...valid, playerId }))).toEqual(["playerId"]);
  });

  test.each([
    ["a number", 25],
    ["a string", "25.00 BRL"],
    ["null", null],
    ["an array", [{ amount: "1.00", currency: "BRL" }]],
  ])("initialBalance that is %s", (_name, initialBalance) => {
    expect(fields(() => parseOpenWalletBody({ ...valid, initialBalance }))).toEqual(["initialBalance"]);
  });

  test("missing and unknown money fields are named", () => {
    expect(fields(() => parseOpenWalletBody({ ...valid, initialBalance: { amount: "1.00" } }))).toEqual([
      "initialBalance.currency",
    ]);
    expect(
      fields(() =>
        parseOpenWalletBody({ ...valid, initialBalance: { amount: "1.00", currency: "BRL", extra: 1 } }),
      ),
    ).toEqual(["initialBalance.extra"]);
  });

  // FR-01: the amount is a string with exactly two decimals, and nothing else is money.
  test.each([
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals", "25.001"],
    ["negative", "-1.00"],
    ["scientific notation", "1e3"],
    ["a number, not a string", 25],
    ["a float", 25.5],
    ["null", null],
    ["empty", ""],
    ["NaN", "NaN"],
    ["over what the column holds", "1000000000000000000.00"],
  ])("an amount that is %s", (_name, amount) => {
    expect(
      fields(() => parseOpenWalletBody({ ...valid, initialBalance: { amount, currency: "BRL" } })),
    ).toEqual(["initialBalance"]);
  });

  test.each(["brl", "BR", "BRLX", "", 986, null])("a currency of %p", (currency) => {
    expect(
      fields(() => parseOpenWalletBody({ ...valid, initialBalance: { amount: "1.00", currency } })),
    ).toEqual(["initialBalance"]);
  });

  test("every problem is reported at once, so one round trip fixes the request", () => {
    const found = fields(() =>
      parseOpenWalletBody({
        playerId: "nope",
        initialBalance: { amount: "1", currency: "x" },
        surprise: true,
      }),
    );
    expect(found).toEqual(["initialBalance", "playerId", "surprise"]);
  });

  test("the reason says what is wrong with money", () => {
    const [issue] = issuesOf(() =>
      parseOpenWalletBody({ ...valid, initialBalance: { amount: "25.5", currency: "BRL" } }),
    );
    expect(issue?.reason).toMatch(/two decimals/);
  });
});

describe("a wallet id in a path", () => {
  test("a UUID is accepted and lowercased", () => {
    expect(parseWalletId(PLAYER.toUpperCase())).toBe(PLAYER);
  });

  test.each(["", "abc", "1", `${PLAYER}x`, "../etc/passwd", "'; drop table wallets;--", undefined])(
    "%p is refused, not passed to the database",
    (value) => {
      expect(fields(() => parseWalletId(value))).toEqual(["walletId"]);
    },
  );
});

describe("the ledger query string", () => {
  test("nothing given is fine", () => {
    expect(parseLedgerQuery({})).toEqual({});
    expect(parseLedgerQuery(undefined)).toEqual({});
  });

  test("a cursor and a limit are passed on", () => {
    expect(parseLedgerQuery({ cursor: "abc", limit: "25" })).toEqual({ cursor: "abc", limit: 25 });
  });

  test.each(["0", "1", "200", "000012"])("limit %p is a whole number", (limit) => {
    expect(parseLedgerQuery({ limit }).limit).toBe(Number(limit));
  });

  // Range is the use case's. This only decides whether it is a whole number at all.
  test.each(["abc", "1.5", "-1", "1e2", " 5", "5 ", "", "0x10", "10abc", "1234567890"])(
    "limit %p is not a whole number",
    (limit) => {
      expect(fields(() => parseLedgerQuery({ limit }))).toEqual(["limit"]);
    },
  );

  test("a parameter given twice is refused, since an array is neither", () => {
    expect(fields(() => parseLedgerQuery({ limit: ["1", "2"] }))).toEqual(["limit"]);
    expect(fields(() => parseLedgerQuery({ cursor: ["a", "b"] }))).toEqual(["cursor"]);
  });

  test("an empty cursor is refused", () => {
    expect(fields(() => parseLedgerQuery({ cursor: "" }))).toEqual(["cursor"]);
  });

  test("unknown query parameters are ignored: they carry nothing we store (INT-25)", () => {
    expect(parseLedgerQuery({ utm_source: "x", limit: "5" })).toEqual({ limit: 5 });
  });
});
