import { describe, expect, test } from "bun:test";
import { InvalidRequestError, WalletNotFoundError } from "../../../src/wagering/application/errors";
import { encodeLedgerCursor } from "../../../src/wagering/application/ledger-cursor";
import type { WalletReader } from "../../../src/wagering/application/ports";
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
  QueryWallets,
} from "../../../src/wagering/application/query-wallets";
import type { Wallet } from "../../../src/wagering/domain/wallet";
import type { WalletLedgerEntry } from "../../../src/wagering/domain/wallet-ledger-entry";
import { brl, T0, walletWith } from "../../support/domain-fixtures";

/** A wallet with `count` ledger entries at versions 2..count+1, and a reader that serves them like the database does. */
function fixture(count: number) {
  const wallet = walletWith("1000000.00");
  const entries: WalletLedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(wallet.credit(brl("1.00"), { transactionId: `t${i}`, entryId: `e${i}`, at: T0 }));
  }
  const calls: Array<{ after: number; limit: number }> = [];
  const reader: WalletReader = {
    async findWallet(id) {
      return id === wallet.id ? wallet : undefined;
    },
    async ledgerAfter(_walletId, after, limit) {
      calls.push({ after, limit });
      return entries.filter((entry) => entry.walletVersion > after).slice(0, limit);
    },
  };
  return { wallet: wallet as Wallet, entries, calls, queries: new QueryWallets(reader) };
}

describe("getWallet", () => {
  test("returns the wallet as it is", async () => {
    const { wallet, queries } = fixture(0);
    const view = await queries.getWallet(wallet.id);
    expect(view).toMatchObject({ id: wallet.id, playerId: wallet.playerId, version: 1 });
    expect(view.balance.toString()).toBe("1000000.00 BRL");
  });

  test("a wallet that does not exist", async () => {
    await expect(fixture(0).queries.getWallet("missing")).rejects.toThrow(WalletNotFoundError);
  });
});

describe("limits (FR-60, SR-04)", () => {
  test("the defaults are the documented ones", () => {
    expect(DEFAULT_LEDGER_LIMIT).toBe(50);
    expect(MAX_LEDGER_LIMIT).toBe(200);
  });

  test("with no limit, a page holds the default, and one more is asked of the reader to learn if there is a next page", async () => {
    const { wallet, queries, calls } = fixture(120);
    const page = await queries.getLedger(wallet.id, {});
    expect(page.entries).toHaveLength(50);
    expect(calls).toEqual([{ after: 0, limit: 51 }]);
  });

  test.each([1, 50, 200])("%i is accepted", async (limit) => {
    const { wallet, queries } = fixture(3);
    await expect(queries.getLedger(wallet.id, { limit })).resolves.toBeDefined();
  });

  test.each([0, -1, 201, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "%p is refused, and the reader is never asked",
    async (limit) => {
      const { wallet, queries, calls } = fixture(3);
      await expect(queries.getLedger(wallet.id, { limit })).rejects.toThrow(InvalidRequestError);
      expect(calls).toEqual([]);
    },
  );
});

describe("paging", () => {
  test("a short ledger is one page with no next cursor", async () => {
    const { wallet, queries } = fixture(3);
    const page = await queries.getLedger(wallet.id, { limit: 10 });
    expect(page.entries).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });

  test("a ledger of exactly one page has no next cursor, so a caller never fetches an empty page", async () => {
    const { wallet, queries } = fixture(5);
    expect((await queries.getLedger(wallet.id, { limit: 5 })).nextCursor).toBeUndefined();
    expect((await queries.getLedger(wallet.id, { limit: 4 })).nextCursor).toBeDefined();
  });

  test("following the cursors visits every entry once, in order, with none skipped", async () => {
    const { wallet, entries, queries } = fixture(23);
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queries.getLedger(wallet.id, { cursor, limit: 5 });
      seen.push(...page.entries.map((entry) => entry.walletVersion));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(entries.map((entry) => entry.walletVersion));
    expect(pages).toBe(5);
  });

  test("the cursor means 'after the last entry returned'", async () => {
    const { wallet, queries, calls } = fixture(10);
    const first = await queries.getLedger(wallet.id, { limit: 4 });
    const last = first.entries.at(-1);
    expect(first.nextCursor).toBe(encodeLedgerCursor(last?.walletVersion ?? -1));
    await queries.getLedger(wallet.id, { cursor: first.nextCursor, limit: 4 });
    expect(calls.at(-1)?.after).toBe(last?.walletVersion);
  });

  test("an empty ledger is an empty page", async () => {
    const { wallet, queries } = fixture(0);
    expect(await queries.getLedger(wallet.id, {})).toEqual({ entries: [], nextCursor: undefined });
  });

  test("a bad cursor is refused before the reader is asked", async () => {
    const { wallet, queries, calls } = fixture(3);
    await expect(queries.getLedger(wallet.id, { cursor: "garbage!" })).rejects.toThrow(InvalidRequestError);
    expect(calls).toEqual([]);
  });

  test("a wallet that does not exist has no ledger", async () => {
    const { queries, calls } = fixture(3);
    await expect(queries.getLedger("missing", {})).rejects.toThrow(WalletNotFoundError);
    expect(calls).toEqual([]);
  });
});
