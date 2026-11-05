import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BODY_LIMIT } from "../../src/app";
import { payloadHash } from "../../src/wagering/application/payload-hash";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";
import { type RunningApp, startApp } from "../support/app";
import { call } from "../support/http";
import { brl, SettlementWorld } from "../support/settlement";

// POST /wagering/transactions end to end: the whole application, a real database, and real parallelism.

let world: SettlementWorld;
let app: RunningApp;
beforeAll(async () => {
  world = await SettlementWorld.create();
  app = await startApp(world.databaseUrl());
});
afterAll(async () => {
  await app.stop();
  await world.destroy();
});

type Target = { walletId: string; playerId: string };
type Body = Record<string, unknown>;
const money = (amount: string, currency = "BRL") => ({ amount, currency });

const bet = (target: Target, overrides: Body = {}): Body => ({
  providerId: "provider-a",
  externalTransactionId: randomUUID(),
  playerId: target.playerId,
  walletId: target.walletId,
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: money("80.00"),
  ...overrides,
});

/** The key is the challenge's recommended default unless the test gives one, or null to omit the header. */
function submit(
  url: string,
  body: Body,
  options: { key?: string | null; headers?: Record<string, string> } = {},
) {
  const key = options.key === undefined ? `${body.providerId}:${body.externalTransactionId}` : options.key;
  return call(`${url}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}
const post = (body: Body, options: Parameters<typeof submit>[2] = {}) => submit(app.url, body, options);

describe("each outcome is its own status (§9)", () => {
  test("applied is 200, in the shape of the challenge's example", async () => {
    const wallet = await world.openWallet("1000.00");
    const response = await post(bet(wallet, { money: money("25.00") }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["balance", "idempotentReplay", "status", "transactionId"]);
    expect(body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(body.transactionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("refused by a business rule is 422, with the reason", async () => {
    const wallet = await world.openWallet("10.00");
    const response = await post(bet(wallet));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
    });
  });

  test("waiting for its reference is 202", async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet, { kind: "REFUND", referenceExternalTransactionId: "not-yet" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00" },
    });
  });

  test("another player's wallet is 422 and the response carries no balance (FR-58)", async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet, { playerId: randomUUID() }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ failureCode: "PLAYER_WALLET_MISMATCH" });
    expect(body).not.toHaveProperty("balance");
  });

  test("a currency the wallet does not hold is 422 too, with no balance", async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet, { money: money("1.00", "USD") }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ failureCode: "CURRENCY_MISMATCH" });
    expect(body).not.toHaveProperty("balance");
  });

  // The failure mode on the issue: a provider decides whether to resend from the status alone.
  test("a bad request, a missing wallet, a conflict, a rejection, a wait and an applied bet all differ", async () => {
    const wallet = await world.openWallet("100.00");
    const applied = bet(wallet, { money: money("10.00") });
    const statuses = {
      applied: (await post(applied)).status,
      waiting: (await post(bet(wallet, { kind: "REFUND", referenceExternalTransactionId: "later" }))).status,
      rejected: (await post(bet(wallet, { money: money("5000.00") }))).status,
      conflict: (
        await post(
          { ...applied, money: money("11.00") },
          { key: `provider-a:${applied.externalTransactionId}` },
        )
      ).status,
      missingWallet: (await post(bet({ walletId: randomUUID(), playerId: wallet.playerId }))).status,
      invalid: (await post(bet(wallet, { kind: "TIP" }))).status,
    };
    expect(statuses).toEqual({
      applied: 200,
      waiting: 202,
      rejected: 422,
      conflict: 409,
      missingWallet: 404,
      invalid: 400,
    });
    expect(new Set(Object.values(statuses)).size).toBe(6);
  });

  test("a whole round: bet, win, loss, refund and rollback", async () => {
    const wallet = await world.openWallet("100.00");
    const first = bet(wallet, { money: money("30.00") });
    expect((await post(first)).status).toBe(200);
    const win = bet(wallet, {
      kind: "WIN",
      money: money("45.50"),
      referenceExternalTransactionId: first.externalTransactionId,
    });
    expect((await post(win)).status).toBe(200);
    expect((await post(bet(wallet, { kind: "LOSS", money: money("0.00") }))).status).toBe(200);
    const second = bet(wallet, { money: money("20.00") });
    await post(second);
    expect(
      (
        await post(
          bet(wallet, {
            kind: "REFUND",
            money: money("20.00"),
            referenceExternalTransactionId: second.externalTransactionId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          bet(wallet, {
            kind: "ROLLBACK",
            money: money("45.50"),
            referenceExternalTransactionId: win.externalTransactionId,
          }),
        )
      ).status,
    ).toBe(200);
    // 100 - 30 + 45.50 - 20 + 20 - 45.50
    expect((await world.walletState(wallet.walletId)).balance).toBe("70.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("idempotency (FR-50 to FR-54)", () => {
  test("a replay is the same answer, flagged, and moves nothing (FR-52)", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    const original = await (await post(request)).json();
    const replay = await post(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test("a replay returns the balance it saw, after the wallet has moved on", async () => {
    const wallet = await world.openWallet("100.00");
    const first = bet(wallet, { money: money("10.00") });
    await post(first);
    await post(bet(wallet, { money: money("30.00") }));
    const replay = await (await post(first)).json();
    expect(replay.balance.amount).toBe("90.00");
  });

  test("a rejection replays as a 422, once the money is there (FR-57)", async () => {
    const wallet = await world.openWallet("10.00");
    const request = bet(wallet);
    await post(request);
    await post(bet(wallet, { kind: "WIN", money: money("500.00") }));
    const replay = await post(request);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({
      failureCode: "INSUFFICIENT_FUNDS",
      idempotentReplay: true,
      balance: { amount: "10.00" },
    });
  });

  test("a wait replays as a 202 (FR-56)", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: "later" });
    await post(request);
    const replay = await post(request);
    expect(replay.status).toBe(202);
    expect((await replay.json()).idempotentReplay).toBe(true);
  });

  test("the key with another payload is a 409, never a replay (FR-53)", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    await post(request);
    const response = await post({ ...request, money: money("1.00") });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
  });

  test("the same operation under another key is a 409 (FR-54)", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    await post(request);
    const response = await post(request, { key: "a-different-key" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("EXTERNAL_ID_CONFLICT");
  });

  test("the header is the truth: any key works, not only the recommended default", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    expect((await post(request, { key: "any-string-the-provider-likes" })).status).toBe(200);
    expect((await post(request, { key: "any-string-the-provider-likes" })).status).toBe(200);
    expect((await world.counts(wallet.walletId)).entries).toBe(1);
  });

  test("transport details do not make a replay a conflict: the correlation id differs every time", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    await post(request, { headers: { "x-correlation-id": "first" } });
    const replay = await post(request, { headers: { "x-correlation-id": "second" } });
    expect((await replay.json()).idempotentReplay).toBe(true);
  });

  test("the header is required", async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet), { key: null });
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toEqual([
      { field: "Idempotency-Key", reason: "is required" },
    ]);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
  });

  test("a key over 255 characters is a 400, not a database error", async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet), { key: "k".repeat(256) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.details[0].field).toBe("Idempotency-Key");
  });
});

describe("what is refused before anything is stored", () => {
  async function refused(wallet: Target, body: Body, options: Parameters<typeof submit>[2] = {}) {
    const response = await post(body, options);
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
    return error.details as Array<{ field: string; reason: string }>;
  }

  test.each([
    ["OPENING, which only the system creates", { kind: "OPENING" }, "kind"],
    ["the reserved provider", { providerId: "internal" }, "providerId"],
    ["a BET with a reference", { referenceExternalTransactionId: "x" }, "referenceExternalTransactionId"],
    ["a REFUND with none", { kind: "REFUND" }, "referenceExternalTransactionId"],
    ["a zero BET", { money: money("0.00") }, "money"],
    ["an amount without two decimals", { money: money("25") }, "money"],
    ["a negative amount", { money: money("-5.00") }, "money"],
    ["an unknown field", { surprise: true }, "surprise"],
    ["a wallet id that is not a UUID", { walletId: "wallet-1" }, "walletId"],
    [
      "an id with a NUL, which PostgreSQL would refuse",
      { externalTransactionId: "a\u0000b" },
      "externalTransactionId",
    ],
  ])("%s", async (_name, overrides, field) => {
    const wallet = await world.openWallet("100.00");
    const details = await refused(wallet, bet(wallet, overrides as Body), { key: `k-${randomUUID()}` });
    expect(details.map((detail) => detail.field)).toContain(field);
  });

  test("a body that is not JSON", async () => {
    const response = await call(`${app.url}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      body: "{broken",
    });
    expect(response.status).toBe(400);
  });

  test(`a body over ${BODY_LIMIT} is a 413`, async () => {
    const wallet = await world.openWallet("100.00");
    const response = await post(bet(wallet, { padding: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("a wallet that does not exist is a 404 and stores nothing", async () => {
    const stranger = { walletId: randomUUID(), playerId: randomUUID() };
    const response = await post(bet(stranger));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("WALLET_NOT_FOUND");
    expect(
      (
        await world.sql("select count(*)::int as n from wager_transactions where wallet_id = ?", [
          stranger.walletId,
        ])
      )[0]?.n,
    ).toBe(0);
  });
});

describe("with real parallelism (§13)", () => {
  test("the same bet 50 times gives one debit", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, { money: money("1.00") });
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(request)));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(bodies.filter((body) => !body.idempotentReplay)).toHaveLength(1);
    expect(bodies.every((body) => body.balance.amount === "99.00")).toBe(true);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "99.00", version: 2 });
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("balance 100 and two bets of 80: one applied, one rejected, 20 left, one debit", async () => {
    const wallet = await world.openWallet("100.00");
    const responses = await Promise.all([post(bet(wallet)), post(bet(wallet))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const rejected = await (
      responses.find((response) => response.status === 422) as Awaited<ReturnType<typeof post>>
    ).json();
    expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect((await world.counts(wallet.walletId)).entries).toBe(1);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("thirty distinct bets of 5.00 against 100.00: exactly twenty fit", async () => {
    const wallet = await world.openWallet("100.00");
    const responses = await Promise.all(
      Array.from({ length: 30 }, () => post(bet(wallet, { money: money("5.00") }))),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(20);
    expect(statuses.filter((status) => status === 422)).toHaveLength(10);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "0.00", version: 21 });
    expect((await world.counts(wallet.walletId)).entries).toBe(20);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("ten wallets at once each end correct", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => world.openWallet("100.00")));
    const responses = await Promise.all(wallets.flatMap((wallet) => [post(bet(wallet)), post(bet(wallet))]));
    expect(
      responses
        .map((response) => response.status)
        .sort()
        .join(),
    ).toBe([...Array(10).fill(200), ...Array(10).fill(422)].join());
    for (const wallet of wallets) {
      expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
      await world.expectLedgerExplainsBalance(wallet.walletId);
    }
  });
});

describe("a lock that does not come in time is a 503 (NFR-11)", () => {
  let impatient: RunningApp;
  beforeAll(async () => {
    impatient = await startApp(world.databaseUrl(), { env: { LOCK_TIMEOUT_MS: "100" } });
  });
  afterAll(() => impatient.stop());

  test("the provider is told to try again, and when", async () => {
    const wallet = await world.openWallet("100.00");
    const release = await world.holdLock(wallet.walletId);
    const request = bet(wallet);
    const response = await submit(impatient.url, request, { headers: { "x-correlation-id": "lock-1" } });
    await release();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect((await response.json()).error.code).toBe("TRANSIENT_FAILURE");
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });

    // It says so in the log, as a warning and not as a bug, with the reason.
    const entries = impatient.logs.filter((entry) => entry.correlationId === "lock-1");
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
    expect(String(entries[0]?.error)).toContain("55P03");

    // Sending the same thing again is safe, and now it applies once.
    const retry = await submit(impatient.url, request);
    expect(retry.status).toBe(200);
    expect((await retry.json()).idempotentReplay).toBe(false);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("it is told apart from a rejection and from a bad request", async () => {
    const wallet = await world.openWallet("100.00");
    const release = await world.holdLock(wallet.walletId);
    const transient = await submit(impatient.url, bet(wallet));
    await release();
    const rejected = await submit(impatient.url, bet(wallet, { money: money("5000.00") }));
    const invalid = await submit(impatient.url, bet(wallet, { kind: "TIP" }));
    expect(new Set([transient.status, rejected.status, invalid.status]).size).toBe(3);
    expect([transient.status, rejected.status, invalid.status]).toEqual([503, 422, 400]);
  });
});

describe("a burst larger than the pool (issue #14)", () => {
  // Four connections, 200 ms to wait for one, 300 ms to wait for a lock. The hot wallet's lock is held for the
  // whole burst, so every request for it must end by giving up, and the others compete for the same few
  // connections. The point is that nothing hangs, nothing is a 500, and nothing is lost or doubled.
  let small: RunningApp;
  beforeAll(async () => {
    small = await startApp(world.databaseUrl(), {
      env: { DATABASE_POOL_MAX: "4", DATABASE_ACQUIRE_TIMEOUT_MS: "200", LOCK_TIMEOUT_MS: "300" },
    });
  });
  afterAll(() => small.stop());

  test("every request ends in a defined outcome, and the books balance afterwards", async () => {
    const hot = await world.openWallet("1000.00");
    const calm = await world.openWallet("1000.00");
    const release = await world.holdLock(hot.walletId);

    const hotBets = Array.from({ length: 24 }, () => bet(hot, { money: money("1.00") }));
    const calmBets = Array.from({ length: 8 }, () => bet(calm, { money: money("1.00") }));
    small.logs.length = 0;
    const started = performance.now();
    const settled = await Promise.all(
      [...hotBets, ...calmBets].map(async (request) => ({
        request,
        response: await submit(small.url, request),
      })),
    );
    const reads = await Promise.all(
      Array.from({ length: 6 }, () => call(`${small.url}/wallets/${calm.walletId}`)),
    );
    const elapsed = performance.now() - started;

    // Nothing hangs: acquire (200 ms) + lock (300 ms) + work, with a wide margin for a loaded machine.
    expect(elapsed).toBeLessThan(4_000);

    for (const { response } of settled) {
      expect([200, 422, 503]).toContain(response.status);
      if (response.status === 503) {
        expect(response.headers.get("retry-after")).toBe("1");
        expect((await response.json()).error.code).toBe("TRANSIENT_FAILURE");
      }
    }
    for (const read of reads) expect([200, 503]).toContain(read.status);

    // The hot wallet is locked throughout, so none of its bets can have been applied.
    const hotOutcomes = settled
      .filter(({ request }) => hotBets.includes(request))
      .map(({ response }) => response.status);
    expect(hotOutcomes.every((status) => status === 503)).toBe(true);

    // Both bounds were really in play: some gave up waiting for a connection, some for the lock.
    const reasons = small.logs.filter((entry) => entry.level === "warn").map((entry) => String(entry.error));
    expect(reasons.some((reason) => reason.includes("no database connection"))).toBe(true);
    const lockTimeouts = reasons.filter((reason) => reason.includes("55P03")).length;
    expect(lockTimeouts).toBeGreaterThanOrEqual(1);
    // The pool is what caps the damage. A connection that waits for the lock is held, and waiting for a connection
    // gives up sooner (200 ms) than waiting for the lock (300 ms), so there is no second wave: at most as many
    // requests can ever have waited on the lock as the pool has connections. A pool of ten would show up here.
    expect(lockTimeouts).toBeLessThanOrEqual(4);
    expect(small.logs.filter((entry) => entry.level === "error")).toEqual([]);

    // Release the lock and send everything again with the same keys: safe, and each ends applied exactly once.
    await release();
    const retried = await Promise.all(settled.map(({ request }) => submit(small.url, request)));
    for (const response of retried) expect(response.status).toBe(200);

    expect(await world.walletState(hot.walletId)).toEqual({ balance: "976.00", version: 25 });
    expect(await world.walletState(calm.walletId)).toEqual({ balance: "992.00", version: 9 });
    expect((await world.counts(hot.walletId)).entries).toBe(24);
    expect((await world.counts(calm.walletId)).entries).toBe(8);
    await world.expectLedgerExplainsBalance(hot.walletId);
    await world.expectLedgerExplainsBalance(calm.walletId);
  });

  test("the pool is not left empty by the burst: the application serves normally afterwards", async () => {
    const wallet = await world.openWallet("100.00");
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => submit(small.url, bet(wallet, { money: money("1.00") }))),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await call(`${small.url}/health/ready`)).status).toBe(200);
  });
});

describe("reading a transaction", () => {
  test("by our id and by the provider's own, the same answer", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, { money: money("25.00") });
    const { transactionId } = await (await post(request)).json();

    const byId = await call(`${app.url}/wagering/transactions/${transactionId}`);
    const byExternal = await call(
      `${app.url}/providers/provider-a/wagering/transactions/${request.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byExternal.status).toBe(200);
    const body = await byId.json();
    expect(await byExternal.json()).toEqual(body);
    expect(body).toMatchObject({
      transactionId,
      providerId: "provider-a",
      externalTransactionId: request.externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
    });
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    expect(body).not.toHaveProperty("failureCode");
  });

  test("a rejection shows its code, and a withheld balance stays withheld", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, { playerId: randomUUID() });
    await post(request);
    const body = await (
      await call(`${app.url}/providers/provider-a/wagering/transactions/${request.externalTransactionId}`)
    ).json();
    expect(body).toMatchObject({ status: "REJECTED", failureCode: "PLAYER_WALLET_MISMATCH" });
    expect(body).not.toHaveProperty("balance");
  });

  test("a reversal shows what it points at", async () => {
    const wallet = await world.openWallet("100.00");
    const first = bet(wallet);
    const { transactionId } = await (await post(first)).json();
    const refund = bet(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: first.externalTransactionId,
    });
    await post(refund);
    const body = await (
      await call(`${app.url}/providers/provider-a/wagering/transactions/${refund.externalTransactionId}`)
    ).json();
    expect(body).toMatchObject({
      referenceExternalTransactionId: first.externalTransactionId,
      referenceTransactionId: transactionId,
    });
  });

  test("an unknown one is a 404, and a malformed id is a 400", async () => {
    const missing = await call(`${app.url}/wagering/transactions/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("TRANSACTION_NOT_FOUND");
    expect((await call(`${app.url}/providers/provider-a/wagering/transactions/nothing`)).status).toBe(404);
    expect((await call(`${app.url}/wagering/transactions/not-a-uuid`)).status).toBe(400);
  });

  test("another provider's id is not found: ids belong to their provider (FR-26)", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    await post(request);
    expect(
      (await call(`${app.url}/providers/provider-b/wagering/transactions/${request.externalTransactionId}`))
        .status,
    ).toBe(404);
  });

  test("a provider id with characters that need encoding still works", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, {
      providerId: "provider with spaces/and slash",
      externalTransactionId: "tx 1/2",
    });
    await post(request);
    const url = `${app.url}/providers/${encodeURIComponent("provider with spaces/and slash")}/wagering/transactions/${encodeURIComponent("tx 1/2")}`;
    expect((await call(url)).status).toBe(200);
  });
});

describe("a transaction that ended in a failure", () => {
  // FAILED is set by the retry worker (#19), which does not exist yet, so the row is stored directly.
  test("asking again is a 500 that says to use a new id, and it is logged as an error", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet);
    const fields = {
      providerId: "provider-a",
      externalTransactionId: request.externalTransactionId as string,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: brl("80.00"),
    };
    const id = randomUUID();
    await world.sql(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', 80, 'BRL', 'FAILED', 'SETTLEMENT_FAILED', now(), now())`,
      [
        id,
        "provider-a",
        fields.externalTransactionId,
        `provider-a:${fields.externalTransactionId}`,
        payloadHash(fields),
        wallet.walletId,
        wallet.playerId,
        "round-1",
        "game-1",
      ],
    );

    app.logs.length = 0;
    const response = await post(request, { headers: { "x-correlation-id": "failed-1" } });
    expect(response.status).toBe(500);
    const { error } = await response.json();
    expect(error.code).toBe("SETTLEMENT_FAILED");
    expect(error.message).toContain("new id");
    expect(
      app.logs.filter((entry) => entry.correlationId === "failed-1").map((entry) => entry.level),
    ).toEqual(["error"]);

    const read = await (await call(`${app.url}/wagering/transactions/${id}`)).json();
    expect(read).toMatchObject({ status: "FAILED", failureCode: "SETTLEMENT_FAILED" });
    expect((await world.walletState(wallet.walletId)).balance).toBe("100.00");
  });
});

describe("the events it writes", () => {
  test("carry the caller's correlation id, and the key as what caused them", async () => {
    const wallet = await world.openWallet("100.00");
    const request = bet(wallet, { money: money("10.00") });
    await post(request, { key: "chosen-by-the-provider", headers: { "x-correlation-id": "round-trip-9" } });
    const rows = await world.sql("select event_type, payload from outbox_messages where aggregate_id = ?", [
      wallet.walletId,
    ]);
    const caused = rows.filter((row) => row.payload.causationId === "chosen-by-the-provider");
    expect(caused.map((row) => row.event_type).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const row of caused) expect(row.payload.correlationId).toBe("round-trip-9");
  });
});
