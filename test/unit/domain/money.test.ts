import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  // FR-01
  test.each(["0.00", "0.01", "25.00", "1000.00", "999999999999999999.99"])(
    "accepts %s and serializes it unchanged",
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
    },
  );

  // FR-01: each of these is a real way a provider or a float could send a bad value.
  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals", "25.000"],
    ["over-precise value", "1.005"],
    ["no integer part", ".50"],
    ["trailing dot", "25."],
    ["negative", "-25.00"],
    ["explicit plus", "+25.00"],
    ["leading zero", "007.00"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative Infinity", "-Infinity"],
    ["scientific notation", "1e3"],
    ["scientific with scale", "1.00e2"],
    ["hexadecimal", "0x10.00"],
    ["thousands separator", "1,000.00"],
    ["comma decimal", "25,00"],
    ["underscore", "1_000.00"],
    ["leading space", " 25.00"],
    ["trailing newline", "25.00\n"],
    ["non-ASCII digits", "٢٥.٠٠"],
  ])("rejects %s", (_name, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  // JSON can carry any of these in the amount field, and TypeScript types vanish at runtime.
  test.each([[25], [25.5], [null], [undefined], [true], [{}], [["25.00"]]])(
    "rejects the non-string amount %p",
    (amount) => {
      expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  // FR-05: numeric(20,2) holds 18 integer digits.
  test("rejects a value that would not fit the database column", () => {
    expect(() => brl("1000000000000000000.00")).toThrow(InvalidMoneyError);
  });

  test.each(["", "BR", "BRLX", "brl", "R$", "B1L"])("rejects the currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("rejects a non-string currency", () => {
    expect(() => Money.from({ amount: "1.00", currency: 986 as unknown as string })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe("arithmetic", () => {
  // FR-02: these all give a different answer in floating point.
  test.each([
    ["0.10", "0.20", "0.30"],
    ["1.10", "2.20", "3.30"],
    ["0.07", "0.01", "0.08"],
    ["4.35", "0.00", "4.35"],
  ])("adds %s and %s exactly", (a, b, sum) => {
    expect(brl(a).add(brl(b)).toJSON().amount).toBe(sum);
  });

  test.each([
    ["0.30", "0.10", "0.20"],
    ["1.00", "0.90", "0.10"],
    ["100.00", "80.00", "20.00"],
    ["80.00", "80.00", "0.00"],
  ])("subtracts %s minus %s exactly", (a, b, difference) => {
    expect(brl(a).subtract(brl(b)).toJSON().amount).toBe(difference);
  });

  test("stays exact beyond the range a float can represent", () => {
    // 2^53 + 1 is the first integer a double cannot hold.
    expect(brl("9007199254740992.00").add(brl("1.00")).toJSON().amount).toBe("9007199254740993.00");
    expect(brl("999999999999999999.99").subtract(brl("0.01")).toJSON().amount).toBe("999999999999999999.98");
  });

  test("never rounds: a thousand additions of one cent are exactly ten", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.toJSON().amount).toBe("10.00");
  });

  test("is immutable: every operation returns a new value", () => {
    const original = brl("10.00");
    const sum = original.add(brl("5.00"));
    const difference = original.subtract(brl("5.00"));
    const negated = original.negate();
    expect(original.toJSON().amount).toBe("10.00");
    expect([sum, difference, negated].includes(original)).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe("negative values", () => {
  // FR-04: negative is reachable internally, and only input contracts refuse it.
  test("subtraction can go below zero, for a signed reconciliation difference", () => {
    const difference = brl("1.00").subtract(brl("1.50"));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON().amount).toBe("-0.50");
  });

  test("negate flips the sign, and twice returns the same value", () => {
    expect(brl("25.00").negate().toJSON().amount).toBe("-25.00");
    expect(brl("25.00").negate().negate().equals(brl("25.00"))).toBe(true);
  });

  test("negating zero stays an unsigned zero", () => {
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
    expect(Money.zero("BRL").negate().isNegative()).toBe(false);
  });

  test("a negative value below one unit keeps its sign and padding", () => {
    expect(brl("0.05").negate().toJSON().amount).toBe("-0.05");
  });
});

describe("queries", () => {
  test("isZero, isPositive, isNegative are mutually exclusive", () => {
    const states = (money: Money) => [money.isZero(), money.isPositive(), money.isNegative()];
    expect(states(brl("0.00"))).toEqual([true, false, false]);
    expect(states(brl("0.01"))).toEqual([false, true, false]);
    expect(states(brl("0.01").negate())).toEqual([false, false, true]);
  });

  test("isLessThan compares by value, not as text", () => {
    expect(brl("9.00").isLessThan(brl("10.00"))).toBe(true);
    expect(brl("10.00").isLessThan(brl("9.00"))).toBe(false);
    expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
    expect(brl("1.00").negate().isLessThan(brl("0.00"))).toBe(true);
  });

  test("equals compares value and currency", () => {
    expect(brl("10.00").equals(brl("10.00"))).toBe(true);
    expect(brl("10.00").equals(brl("10.01"))).toBe(false);
    expect(brl("10.00").equals(Money.from({ amount: "10.00", currency: "USD" }))).toBe(false);
  });

  test("zero is zero in the given currency", () => {
    expect(Money.zero("USD").toJSON()).toEqual({ amount: "0.00", currency: "USD" });
    expect(() => Money.zero("usd")).toThrow(InvalidMoneyError);
  });

  // FR-05: a sum of valid values can still outgrow the column, which settlement must refuse.
  test("reports whether a value fits the database column", () => {
    const max = brl("999999999999999999.99");
    expect(max.fitsStorage()).toBe(true);
    expect(max.add(brl("0.01")).fitsStorage()).toBe(false);
  });
});

describe("currency conflict", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  // FR-03
  test("add raises", () => expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError));
  test("subtract raises", () => expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError));
  test("isLessThan raises", () => expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError));
});

describe("serialization", () => {
  test("JSON.stringify uses the contract form and never a number", () => {
    expect(JSON.stringify(brl("25.00"))).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  test("toString is readable", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });

  test("round-trips through its own JSON", () => {
    const original = brl("1234.56");
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
