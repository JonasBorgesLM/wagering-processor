import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { BODY_LIMIT } from "../../src/app";
import { startApp } from "../support/app";
import { call } from "../support/http";
import { brl, command, SettlementWorld } from "../support/settlement";

// Requirements: FR-66 (roles), FR-67 (reads take no lock).

// The whole application as main builds it, on a real database, called over HTTP.

let world: SettlementWorld;
let app: NestExpressApplication;
let base: string;
async function start(databaseUrl: string, roles = "api") {
  const running = await startApp(databaseUrl, { roles });
  return { instance: running.instance, url: running.url, running };
}

beforeAll(async () => {
  world = await SettlementWorld.create();
  const started = await start(world.databaseUrl());
  app = started.instance;
  base = started.url;
});

afterAll(async () => {
  await app.close();
  await world.destroy();
});

const PLAYER = (): string => randomUUID();
const post = (body: unknown, headers: Record<string, string> = {}) =>
  call(`${base}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const money = (amount: string, currency = "BRL") => ({ amount, currency });
const create = (balance = "1000.00", playerId = PLAYER()) =>
  post({ playerId, initialBalance: money(balance) });

describe("POST /wallets", () => {
  test("creates a wallet: 201 and the documented body (§9)", async () => {
    const playerId = PLAYER();
    const response = await post({ playerId, initialBalance: money("1000.00") });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["balance", "id", "playerId", "version"]);
    expect(body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("a zero balance is a wallet too (FR-12)", async () => {
    const response = await create("0.00");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ balance: { amount: "0.00" }, version: 1 });
  });

  test("the same player in another currency is another wallet", async () => {
    const playerId = PLAYER();
    expect((await post({ playerId, initialBalance: money("5.00", "BRL") })).status).toBe(201);
    expect((await post({ playerId, initialBalance: money("5.00", "USD") })).status).toBe(201);
  });

  test("a duplicate is 409 WALLET_ALREADY_EXISTS (FR-10)", async () => {
    const playerId = PLAYER();
    await create("100.00", playerId);
    const response = await create("999.00", playerId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "WALLET_ALREADY_EXISTS", message: "this player already has a wallet in this currency" },
    });
  });

  test("an uppercase player id is accepted, and answered in lowercase (INT-25)", async () => {
    const playerId = PLAYER();
    const response = await create("1.00", playerId.toUpperCase());
    expect((await response.json()).playerId).toBe(playerId);
    expect((await create("1.00", playerId)).status).toBe(409);
  });
});

describe("a request that cannot be acted on is 400, with every problem listed", () => {
  const valid = () => ({ playerId: PLAYER(), initialBalance: money("1.00") });

  async function refused(body: unknown) {
    const response = await post(body);
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("VALIDATION_ERROR");
    return error.details as Array<{ field: string; reason: string }>;
  }

  test.each([
    ["no body fields", {}, ["initialBalance", "playerId"]],
    ["an array", [valid()], ["body"]],
    ["null", null, ["body"]],
    ["a string", "hello", ["body"]],
    ["a player id that is not a UUID", { ...valid(), playerId: "player-1" }, ["playerId"]],
    ["an unknown field", { ...valid(), initialBalence: 5 }, ["initialBalence"]],
    ["an amount with no decimals", { ...valid(), initialBalance: money("25") }, ["initialBalance"]],
    ["an amount with one decimal", { ...valid(), initialBalance: money("25.5") }, ["initialBalance"]],
    ["a negative amount", { ...valid(), initialBalance: money("-1.00") }, ["initialBalance"]],
    ["scientific notation", { ...valid(), initialBalance: money("1e3") }, ["initialBalance"]],
    [
      "a number instead of a string",
      { ...valid(), initialBalance: { amount: 25, currency: "BRL" } },
      ["initialBalance"],
    ],
    ["a lowercase currency", { ...valid(), initialBalance: money("1.00", "brl") }, ["initialBalance"]],
    ["a missing currency", { ...valid(), initialBalance: { amount: "1.00" } }, ["initialBalance.currency"]],
    [
      "everything wrong at once",
      { playerId: "x", initialBalance: money("1", "z"), extra: 1 },
      ["extra", "initialBalance", "playerId"],
    ],
  ])("%s", async (_name, body, expected) => {
    const details = await refused(body);
    expect(details.map((d) => d.field).sort()).toEqual([...expected].sort());
    for (const detail of details) expect(detail.reason.length).toBeGreaterThan(0);
  });

  test("a body that is not JSON", async () => {
    const response = await call(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  test("a body sent as the wrong content type is not read, and is refused the same way", async () => {
    const response = await call(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(valid()),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  test("an empty body", async () => {
    const response = await call(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
  });

  // SR-04: nothing a caller sends can make us read without limit.
  test(`a body over ${BODY_LIMIT} is 413 with the same envelope`, async () => {
    const response = await post({ ...valid(), padding: "x".repeat(20_000) });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("a refused request creates nothing", async () => {
    const playerId = PLAYER();
    await post({ playerId, initialBalance: money("25") });
    expect(await world.sql("select count(*)::int as n from wallets where player_id = ?", [playerId])).toEqual(
      [{ n: 0 }],
    );
  });
});

describe("GET /wallets/:walletId", () => {
  test("returns the wallet, and the same body as creating it", async () => {
    const created = await (await create("250.50")).json();
    const response = await call(`${base}/wallets/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(created);
  });

  test("tracks the balance as it moves", async () => {
    const created = await (await create("100.00")).json();
    await world.useCase.execute(
      command({ walletId: created.id, playerId: created.playerId }, { money: brl("30.00") }),
    );
    expect(await (await call(`${base}/wallets/${created.id}`)).json()).toMatchObject({
      balance: { amount: "70.00" },
      version: 2,
    });
  });

  test("an uppercase id finds it", async () => {
    const created = await (await create()).json();
    expect((await call(`${base}/wallets/${created.id.toUpperCase()}`)).status).toBe(200);
  });

  test("a wallet that does not exist is 404 WALLET_ALREADY_EXISTS's opposite: WALLET_NOT_FOUND", async () => {
    const response = await call(`${base}/wallets/${randomUUID()}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("WALLET_NOT_FOUND");
  });

  // Passed to PostgreSQL, these would be a syntax error and a 500. They are the caller's mistake and a 400.
  test.each([
    "abc",
    "1",
    "not-a-uuid",
    "..%2fetc%2fpasswd",
    "%27%3B%20drop%20table%20wallets%3B--",
    "0192f291-27dd-7d3f-8071-5f8685deef3",
  ])("%p is 400, not a 500", async (id) => {
    const response = await call(`${base}/wallets/${id}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toEqual([{ field: "walletId", reason: "must be a UUID" }]);
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  async function walletWithBets(count: number) {
    const wallet = await (await create("1000.00")).json();
    for (let i = 0; i < count; i++) {
      await world.useCase.execute(
        command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("1.00") }),
      );
    }
    return wallet.id as string;
  }
  const page = async (id: string, query = "") => {
    const response = await call(`${base}/wallets/${id}/ledger${query}`);
    return { status: response.status, body: await response.json() };
  };

  test("the default page holds the opening entry and what followed, in the documented shape", async () => {
    const id = await walletWithBets(2);
    const { status, body } = await page(id);
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(Object.keys(body.items[1]).sort()).toEqual(
      [
        "balanceAfter",
        "balanceBefore",
        "createdAt",
        "direction",
        "id",
        "money",
        "transactionId",
        "walletVersion",
      ].sort(),
    );
    expect(body.items[0]).toMatchObject({
      direction: "CREDIT",
      money: { amount: "1000.00" },
      balanceBefore: { amount: "0.00" },
      balanceAfter: { amount: "1000.00" },
    });
    expect(body.items[1]).toMatchObject({ direction: "DEBIT", balanceAfter: { amount: "999.00" } });
    expect(new Date(body.items[0].createdAt).toISOString()).toBe(body.items[0].createdAt);
  });

  test("following nextCursor visits every entry once, then stops with null", async () => {
    const id = await walletWithBets(6);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await page(id, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pages).toBe(3);
  });

  test("the cursor survives entries being added between pages", async () => {
    const id = await walletWithBets(4);
    const first = await page(id, "?limit=3");
    const wallet = await (await call(`${base}/wallets/${id}`)).json();
    for (let i = 0; i < 3; i++)
      await world.useCase.execute(
        command({ walletId: id, playerId: wallet.playerId }, { money: brl("1.00") }),
      );
    const second = await page(id, `?limit=100&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([4, 5, 6, 7, 8]);
  });

  test("limit 200 is the most, and 50 is the default", async () => {
    const id = await walletWithBets(0);
    expect((await page(id, "?limit=200")).status).toBe(200);
    expect((await page(id, "?limit=201")).status).toBe(400);
    const defaults = await walletWithBets(54);
    expect((await page(defaults)).body.items).toHaveLength(50);
    expect((await page(defaults)).body.nextCursor).not.toBeNull();
  });

  test.each(["0", "201", "-1", "abc", "1.5", "1e2", "", "99999999999"])(
    "limit=%p is 400 naming the field",
    async (limit) => {
      const id = await walletWithBets(0);
      const { status, body } = await page(id, `?limit=${limit}`);
      expect(status).toBe(400);
      expect(body.error.details[0].field).toBe("limit");
    },
  );

  test.each(["garbage", "a".repeat(300), "e30", "%00", ""])("cursor=%p is 400", async (cursor) => {
    const id = await walletWithBets(0);
    const { status, body } = await page(id, `?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error.details[0].field).toBe("cursor");
  });

  test("a parameter given twice is 400, not silently the first", async () => {
    const id = await walletWithBets(0);
    expect((await page(id, "?limit=1&limit=2")).status).toBe(400);
  });

  test("unknown query parameters are ignored", async () => {
    const id = await walletWithBets(1);
    expect((await page(id, "?utm_source=email")).status).toBe(200);
  });

  test("a wallet that does not exist is 404, and one that is malformed is 400", async () => {
    expect((await page(randomUUID())).status).toBe(404);
    expect((await page("nope")).status).toBe(400);
  });

  test("a zero wallet has an empty ledger", async () => {
    const wallet = await (await create("0.00")).json();
    expect((await page(wallet.id)).body).toEqual({ items: [], nextCursor: null });
  });
});

describe("every response", () => {
  test("carries a correlation id, generated when none is sent", async () => {
    const response = await create();
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("keeps a plain one the caller sent, and ties it to the events", async () => {
    const playerId = PLAYER();
    const response = await post(
      { playerId, initialBalance: money("5.00") },
      { "x-correlation-id": "provider-req-77" },
    );
    expect(response.headers.get("x-correlation-id")).toBe("provider-req-77");
    const wallet = await response.json();
    const rows = await world.sql("select payload from outbox_messages where aggregate_id = ?", [wallet.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload.correlationId).toBe("provider-req-77");
  });

  test("replaces one that is not plain, instead of reflecting it", async () => {
    const response = await create("1.00", PLAYER()).then(() =>
      call(`${base}/wallets/${randomUUID()}`, { headers: { "x-correlation-id": "has space and <tags>" } }),
    );
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("even an error does", async () => {
    const response = await call(`${base}/wallets/${randomUUID()}`);
    expect(response.headers.get("x-correlation-id")).not.toBeNull();
  });

  test("does not announce the framework", async () => {
    expect((await create()).headers.get("x-powered-by")).toBeNull();
  });

  test("answers JSON", async () => {
    expect((await create()).headers.get("content-type")).toContain("application/json");
  });
});

describe("an unknown route is the envelope too", () => {
  test("404 NOT_FOUND", async () => {
    const response = await call(`${base}/nothing-here`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("the platform endpoints keep their own contract", () => {
  test("health is unchanged by the error envelope", async () => {
    expect(await (await call(`${base}/health/live`)).json()).toEqual({ status: "ok" });
    const ready = await call(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ok", postgres: "up", sqs: "up" });
  });
});

describe("a database that cannot be reached is 503 (NFR-11)", () => {
  let broken: NestExpressApplication;
  let brokenUrl: string;
  let brokenLogs: Array<Record<string, unknown>>;
  beforeAll(async () => {
    const started = await start("postgres://wagering:wagering@localhost:1/wagering");
    broken = started.instance;
    brokenUrl = started.url;
    brokenLogs = started.running.logs;
  });
  afterAll(() => broken.close());

  test("reading says to try again, and when", async () => {
    const response = await call(`${brokenUrl}/wallets/${randomUUID()}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect((await response.json()).error.code).toBe("TRANSIENT_FAILURE");
  });

  test("creating does too, and nothing was committed", async () => {
    const response = await call(`${brokenUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: PLAYER(), initialBalance: money("1.00") }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  test("it is told apart from a bug: a warning in the log, never an error", async () => {
    brokenLogs.length = 0;
    await call(`${brokenUrl}/wallets/${randomUUID()}`, { headers: { "x-correlation-id": "outage-1" } });
    const entries = brokenLogs.filter((entry) => entry.correlationId === "outage-1");
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
  });

  test("the response says nothing about the host or the driver", async () => {
    const text = await (await call(`${brokenUrl}/wallets/${randomUUID()}`)).text();
    expect(text).not.toMatch(/ECONNREFUSED|localhost|5432|:1\b|postgres/i);
  });
});

describe("reads take no lock (FR-67)", () => {
  test("a wallet, its ledger and a transaction are read at once while the wallet's lock is held", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = await world.useCase.execute(command(wallet, { money: brl("10.00") }));
    const release = await world.holdLock(wallet.walletId);
    try {
      const started = performance.now();
      const [one, ledger, transaction] = await Promise.all([
        call(`${base}/wallets/${wallet.walletId}`),
        call(`${base}/wallets/${wallet.walletId}/ledger`),
        call(`${base}/wagering/transactions/${bet.transactionId}`),
      ]);
      expect([one.status, ledger.status, transaction.status]).toEqual([200, 200, 200]);
      expect((await one.json()).balance.amount).toBe("90.00");
      // The lock timeout is 2 s: a read that waited for the lock would take that long or fail.
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await release();
    }
  });
});

describe("roles decide what a process serves (ADR-0001)", () => {
  test("a process without the api role has no wallet routes, and still has its health", async () => {
    const started = await start(world.databaseUrl(), "publisher");
    try {
      expect((await call(`${started.url}/wallets/${randomUUID()}`)).status).toBe(404);
      expect((await call(`${started.url}/wallets`, { method: "POST" })).status).toBe(404);
      expect((await call(`${started.url}/health/live`)).status).toBe(200);
    } finally {
      await started.instance.close();
    }
  });
});
