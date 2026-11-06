import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { startApp } from "../support/app";
import {
  eventually,
  message,
  purge,
  queueIsEmpty,
  send,
  setUpQueues,
  sqs,
} from "../support/consumer-harness";
import { call } from "../support/http";
import { brl, command, SettlementWorld } from "../support/settlement";

// SR-01 and section 12: the logs carry the fields that tie a line to a request, a message, a transaction and a
// wallet, and none of the payload. The payload here is made of values that cannot be mistaken for anything else, so
// finding one in a log line is finding the leak.

setDefaultTimeout(30_000);

const SECRET = {
  game: "game-secret-777",
  round: "round-secret-888",
  amount: "12.34",
  key: "key-secret-999",
  external: "external-secret-555",
};

let world: SettlementWorld;
beforeAll(async () => {
  await setUpQueues();
  world = await SettlementWorld.create();
});
afterAll(async () => {
  await purge();
  sqs.destroy();
  await world.destroy();
});
beforeEach(purge);
afterEach(purge);

function expectNoPayload(lines: Array<Record<string, unknown>>, player: string) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const text = JSON.stringify(line);
    for (const secret of [...Object.values(SECRET), player])
      expect(text, `a log line leaked ${secret}`).not.toContain(secret);
  }
}

describe("over HTTP", () => {
  test("a decided transaction is logged with the fields that identify it, and nothing of its payload", async () => {
    const app = await startApp(world.databaseUrl(), { roles: "api" });
    try {
      const wallet = await world.openWallet("100.00");
      const operation = command(wallet, {
        gameId: SECRET.game,
        roundId: SECRET.round,
        externalTransactionId: SECRET.external,
        idempotencyKey: SECRET.key,
        money: brl(SECRET.amount),
      });
      app.logs.length = 0;
      const response = await call(`${app.url}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": SECRET.key,
          "x-correlation-id": "corr-http-1",
        },
        body: JSON.stringify({
          providerId: operation.providerId,
          externalTransactionId: SECRET.external,
          playerId: operation.playerId,
          walletId: operation.walletId,
          roundId: SECRET.round,
          gameId: SECRET.game,
          kind: "BET",
          money: { amount: SECRET.amount, currency: "BRL" },
        }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-correlation-id")).toBe("corr-http-1");

      const line = app.logs.find((l) => l.message === "Transaction decided");
      expect(line).toMatchObject({
        level: "info",
        correlationId: "corr-http-1",
        transactionId: body.transactionId,
        walletId: wallet.walletId,
        providerId: operation.providerId,
        status: "PROCESSED",
      });
      expect(typeof line?.durationMs).toBe("number");
      expectNoPayload(app.logs, wallet.playerId);
    } finally {
      await app.stop();
    }
  });

  test("a refused request is logged with its correlation id and without its payload", async () => {
    const app = await startApp(world.databaseUrl(), { roles: "api" });
    try {
      const wallet = await world.openWallet("100.00");
      const send = (amount: string) =>
        call(`${app.url}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${SECRET.key}-b`,
            "x-correlation-id": "corr-http-2",
          },
          body: JSON.stringify({
            providerId: "provider-a",
            externalTransactionId: `${SECRET.external}-b`,
            playerId: wallet.playerId,
            walletId: wallet.walletId,
            roundId: SECRET.round,
            gameId: SECRET.game,
            kind: "BET",
            money: { amount, currency: "BRL" },
          }),
        });
      expect((await send(SECRET.amount)).status).toBe(200);
      app.logs.length = 0;
      expect((await send("99.99")).status).toBe(409);

      expect(app.logs.find((l) => l.message === "Request refused")).toMatchObject({
        level: "info",
        correlationId: "corr-http-2",
        status: 409,
        error: "IDEMPOTENCY_CONFLICT",
      });
      expectNoPayload(app.logs, wallet.playerId);
    } finally {
      await app.stop();
    }
  });
});

describe("over the queue", () => {
  test("a settled message is logged with its message id, correlation, transaction, wallet and provider", async () => {
    const wallet = await world.openWallet("100.00");
    const app = await startApp(world.databaseUrl(), { roles: "consumer", env: { QUEUE_WAIT_SECONDS: "1" } });
    try {
      const body = message(wallet, {
        messageId: "msg-log-1",
        gameId: SECRET.game,
        roundId: SECRET.round,
        externalTransactionId: `${SECRET.external}-q`,
        idempotencyKey: `${SECRET.key}-q`,
        money: { amount: SECRET.amount, currency: "BRL" },
      });
      await send(body, wallet.walletId);
      await eventually(queueIsEmpty, "the message to be settled");

      const line = app.logs.find((l) => l.message === "Message settled");
      expect(line).toMatchObject({
        correlationId: "msg-log-1",
        messageId: "msg-log-1",
        walletId: wallet.walletId,
        providerId: "provider-a",
        status: "PROCESSED",
      });
      expect(typeof line?.transactionId).toBe("string");
      expectNoPayload(app.logs, wallet.playerId);
    } finally {
      await app.stop();
    }
  });
});

describe("in the reference worker", () => {
  test("a waiting transaction that is decided is logged with its ids and status", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { gameId: SECRET.game, roundId: SECRET.round, money: brl(SECRET.amount) });
    const refund = await world.useCase.execute(
      command(wallet, {
        kind: Kind.Refund,
        gameId: SECRET.game,
        roundId: SECRET.round,
        money: brl(SECRET.amount),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await world.useCase.execute(bet);
    await world.sql(
      "update wager_transactions set next_retry_at = now() - interval '1 second' where id = ?",
      [refund.transactionId],
    );
    const app = await startApp(world.databaseUrl(), {
      roles: "reference-worker",
      env: { REFERENCE_POLL_INTERVAL_MS: "100" },
    });
    try {
      await eventually(
        () =>
          app.logs.some(
            (l) => l.message === "Waiting transaction decided" && l.transactionId === refund.transactionId,
          ),
        "the worker to log its decision",
      );
      const line = app.logs.find((l) => l.message === "Waiting transaction decided");
      expect(line).toMatchObject({
        correlationId: refund.transactionId,
        walletId: wallet.walletId,
        providerId: "provider-a",
        status: "PROCESSED",
      });
      expectNoPayload(app.logs, wallet.playerId);
    } finally {
      await app.stop();
    }
  });
});
