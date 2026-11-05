import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "../../../src/wagering/application/errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "../../../src/wagering/application/ledger-cursor";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("a cursor round-trips", () => {
  test.each([0, 1, 2, 50, 1_000_000, Number.MAX_SAFE_INTEGER])("version %i", (version) => {
    expect(decodeLedgerCursor(encodeLedgerCursor(version))).toBe(version);
  });

  test("it is URL-safe, since it travels in a query string", () => {
    for (const version of [0, 7, 123456789]) expect(encodeLedgerCursor(version)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("the same position is always the same string, and different positions differ", () => {
    expect(encodeLedgerCursor(7)).toBe(encodeLedgerCursor(7));
    expect(encodeLedgerCursor(7)).not.toBe(encodeLedgerCursor(8));
  });
});

describe("anything this API did not issue is refused (SR-04)", () => {
  const refused: Array<[string, string]> = [
    ["empty", ""],
    ["not base64url characters", "not a cursor!"],
    ["with padding or a slash", "abc/def="],
    ["valid base64 of text that is not JSON", Buffer.from("hello").toString("base64url")],
    ["JSON that is an array", encode([1])],
    ["JSON that is a string", encode("7")],
    ["JSON that is null", encode(null)],
    ["a different version", encode({ v: 2, after: 7 })],
    ["no version", encode({ after: 7 })],
    ["no position", encode({ v: 1 })],
    ["a position that is a string", encode({ v: 1, after: "7" })],
    ["a negative position", encode({ v: 1, after: -1 })],
    ["a fractional position", encode({ v: 1, after: 1.5 })],
    ["a position past what a number holds exactly", encode({ v: 1, after: 2 ** 53 })],
    ["an extra key", encode({ v: 1, after: 7, wallet: "other" })],
    ["too long", "a".repeat(201)],
  ];
  test.each(refused)("%s", (_name, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidRequestError);
  });

  // Bun's decoder skips what it does not recognise, so these all decode to a valid cursor. Only the check on the
  // characters refuses them, and only the canonical spelling is ever issued.
  describe("a cursor has one spelling", () => {
    const canonical = encodeLedgerCursor(7);
    const spellings: Array<[string, string]> = [
      ["with padding", `${canonical}=`],
      ["with a dot inside", `${canonical.slice(0, 10)}.${canonical.slice(10)}`],
      ["with a bang inside", `${canonical.slice(0, 10)}!${canonical.slice(10)}`],
      ["with a trailing space", `${canonical} `],
    ];

    test.each(spellings)("%s decodes to the same JSON, and is still refused", (_name, spelling) => {
      expect(Buffer.from(spelling, "base64url").toString()).toBe(JSON.stringify({ v: 1, after: 7 }));
      expect(() => decodeLedgerCursor(spelling)).toThrow(InvalidRequestError);
    });

    test("the canonical one is accepted", () => {
      expect(decodeLedgerCursor(canonical)).toBe(7);
    });
  });

  test("a cursor over 200 characters is refused even when it is valid JSON", () => {
    const json = Buffer.from(`{"v":1,"after":7${" ".repeat(400)}}`).toString("base64url");
    expect(JSON.parse(Buffer.from(json, "base64url").toString())).toEqual({ v: 1, after: 7 });
    expect(json.length).toBeGreaterThan(200);
    expect(() => decodeLedgerCursor(json)).toThrow(InvalidRequestError);
  });

  test("it names the field", () => {
    try {
      decodeLedgerCursor("nope!");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as InvalidRequestError).issues).toEqual([
        { field: "cursor", reason: "is not a cursor this API issued" },
      ]);
    }
  });
});
