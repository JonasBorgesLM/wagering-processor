import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { type RunningApp, startApp } from "../support/app";
import { call } from "../support/http";
import { brl, command, SettlementWorld } from "../support/settlement";

// Requirements: FR-63, FR-65, FR-68, FR-69, FR-100 (the contract of the HTTP API and its response headers).
// docs/openapi.yaml is the machine-readable form of the API. This keeps it true in three ways: every route the running
// application serves is in it and every route in it is served; every example in it is valid against its own schema;
// and what the application really answers, for each operation and status it can be made to give, validates against
// the schema the spec declares for that status. A drift in either direction fails here.

setDefaultTimeout(60_000);

// biome-ignore lint/suspicious/noExplicitAny: the parsed document is arbitrary JSON
type Json = any;
const spec: Json = Bun.YAML.parse(readFileSync("docs/openapi.yaml", "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];

const operations: Array<{ method: string; path: string; op: Json }> = Object.entries(spec.paths).flatMap(
  ([path, item]: [string, Json]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ method: method.toUpperCase(), path, op })),
);

function deref(node: Json): Json {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const target = node.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((object: Json, key: string) => object?.[key], spec);
    if (target === undefined) throw new Error(`unresolved reference ${node.$ref}`);
    return deref(target);
  }
  return node;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "oas", components: spec.components });

/** The schema of a response body, as a validator. A `$ref` into the components is rewritten to the one registered. */
function validatorFor(schema: Json) {
  const rewrite = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
          key,
          key === "$ref" && typeof value === "string" ? value.replace(/^#/, "oas#") : rewrite(value),
        ]),
      );
    }
    return node;
  };
  return ajv.compile(rewrite(schema));
}

let world: SettlementWorld;
let app: RunningApp;
beforeAll(async () => {
  world = await SettlementWorld.create();
  app = await startApp(world.databaseUrl(), { roles: "api" });
});
afterAll(async () => {
  await app.stop();
  await world.destroy();
});

describe("the spec on its own", () => {
  test("is OpenAPI 3.1 and every reference in it resolves", () => {
    expect(spec.openapi).toMatch(/^3\.1/);
    const unresolved: string[] = [];
    const walk = (node: Json) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        if (typeof node.$ref === "string") {
          try {
            deref(node);
          } catch {
            unresolved.push(node.$ref);
          }
        }
        Object.values(node).forEach(walk);
      }
    };
    walk(spec);
    expect(unresolved).toEqual([]);
  });

  test("every operation has a unique id, a summary, and a response for every error a caller can get", () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { method, path, op } of operations) {
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  test("every example validates against its own schema", () => {
    const failures: string[] = [];
    for (const { method, path, op } of operations) {
      for (const [status, response] of Object.entries<Json>(op.responses)) {
        const content = deref(response).content?.["application/json"];
        if (!content?.example) continue;
        const validate = validatorFor(content.schema);
        if (!validate(content.example)) {
          failures.push(`${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`);
        }
      }
      const body = op.requestBody?.content?.["application/json"];
      if (body?.example) {
        const validate = validatorFor(body.schema);
        if (!validate(body.example))
          failures.push(`${method} ${path} request: ${ajv.errorsText(validate.errors)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("the spec and the application agree on the routes", () => {
  test("every route served is in the spec, and every route in the spec is served", () => {
    const express = app.instance.getHttpAdapter().getInstance();
    const stack = (express.router ?? express._router).stack as Json[];
    const served = stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, "{$1}")}`,
        ),
      )
      .sort();
    const documented = operations.map(({ method, path }) => `${method} ${path}`).sort();
    expect(served).toEqual(documented);
  });
});

describe("what the application answers validates against what the spec declares", () => {
  const seen = new Set<string>();

  /** Calls the route and checks the status is documented for the operation and the body fits its schema. */
  async function check(method: string, path: string, response: Response, bodyText?: string) {
    const operation = operations.find((candidate) => candidate.method === method && candidate.path === path);
    expect(operation, `${method} ${path} is in the spec`).toBeDefined();
    const status = String(response.status);
    const declared = (operation as Json).op.responses[status];
    expect(declared, `${method} ${path} answered ${status}, which the spec does not declare`).toBeDefined();
    seen.add(`${method} ${path} ${status}`);
    const content = deref(declared).content;
    if (!content) return;
    const mediaType = response.headers.get("content-type")?.split(";")[0] ?? "";
    const media = content[mediaType];
    expect(
      media,
      `${method} ${path} ${status} answered ${mediaType}, which the spec does not declare`,
    ).toBeDefined();
    if (mediaType !== "application/json") return;
    const body = JSON.parse(bodyText ?? (await response.text()));
    const validate = validatorFor(media.schema);
    expect(validate(body), `${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }

  const get = async (path: string, template: string) => {
    const response = await call(`${app.url}${path}`);
    await check("GET", template, response.clone() as unknown as Response);
    return response;
  };
  const postJson = async (
    path: string,
    template: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await call(`${app.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    await check("POST", template, response.clone() as unknown as Response);
    return response;
  };

  const submitBody = (op: ReturnType<typeof command>) => ({
    providerId: op.providerId,
    externalTransactionId: op.externalTransactionId,
    playerId: op.playerId,
    walletId: op.walletId,
    roundId: op.roundId,
    gameId: op.gameId,
    kind: op.kind,
    money: op.money.toJSON(),
    ...(op.referenceExternalTransactionId
      ? { referenceExternalTransactionId: op.referenceExternalTransactionId }
      : {}),
  });

  test("wallets: create, conflict, invalid, read, ledger, reconciliation, and the refusals", async () => {
    const playerId = randomUUID();
    const created = await postJson("/wallets", "/wallets", {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(created.status).toBe(201);
    const wallet = await created.json();
    expect(
      (
        await postJson("/wallets", "/wallets", {
          playerId,
          initialBalance: { amount: "1.00", currency: "BRL" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await postJson("/wallets", "/wallets", {
          playerId: "nope",
          initialBalance: { amount: "1.5", currency: "BRL" },
        })
      ).status,
    ).toBe(400);
    expect((await postJson("/wallets", "/wallets", { playerId, junk: "x".repeat(20_000) })).status).toBe(413);

    expect((await get(`/wallets/${wallet.id}`, "/wallets/{walletId}")).status).toBe(200);
    expect((await get(`/wallets/${randomUUID()}`, "/wallets/{walletId}")).status).toBe(404);
    expect((await get("/wallets/not-a-uuid", "/wallets/{walletId}")).status).toBe(400);

    expect((await get(`/wallets/${wallet.id}/ledger?limit=1`, "/wallets/{walletId}/ledger")).status).toBe(
      200,
    );
    expect((await get(`/wallets/${wallet.id}/ledger?limit=0`, "/wallets/{walletId}/ledger")).status).toBe(
      400,
    );
    expect((await get(`/wallets/${randomUUID()}/ledger`, "/wallets/{walletId}/ledger")).status).toBe(404);

    const reconciliation = "/wallets/{walletId}/reconciliation";
    expect((await postJson(`/wallets/${wallet.id}/reconciliation`, reconciliation, "")).status).toBe(200);
    expect((await postJson(`/wallets/${randomUUID()}/reconciliation`, reconciliation, "")).status).toBe(404);
    expect((await postJson("/wallets/nope/reconciliation", reconciliation, "")).status).toBe(400);
  });

  test("transactions: applied, waiting, refused, replayed, conflicting, unknown wallet, invalid, and the reads", async () => {
    const wallet = await world.openWallet("100.00");
    const route = "/wagering/transactions";
    const headers = (op: ReturnType<typeof command>) => ({ "idempotency-key": op.idempotencyKey });

    const bet = command(wallet, { money: brl("80.00") });
    const applied = await postJson(route, route, submitBody(bet), headers(bet));
    expect(applied.status).toBe(200);
    const { transactionId } = await applied.json();
    expect((await postJson(route, route, submitBody(bet), headers(bet))).status).toBe(200);

    const broke = command(wallet, { money: brl("80.00") });
    expect((await postJson(route, route, submitBody(broke), headers(broke))).status).toBe(422);

    const early = command(wallet, {
      kind: "REFUND" as never,
      money: brl("1.00"),
      referenceExternalTransactionId: "not-yet",
    });
    expect((await postJson(route, route, submitBody(early), headers(early))).status).toBe(202);

    const conflicting = { ...submitBody(bet), money: { amount: "1.00", currency: "BRL" } };
    expect((await postJson(route, route, conflicting, headers(bet))).status).toBe(409);
    expect((await postJson(route, route, submitBody(bet), { "idempotency-key": "another-key" })).status).toBe(
      409,
    );

    const nowhere = command({ walletId: randomUUID(), playerId: randomUUID() }, { money: brl("1.00") });
    expect((await postJson(route, route, submitBody(nowhere), headers(nowhere))).status).toBe(404);
    expect((await postJson(route, route, { providerId: "x" }, { "idempotency-key": "k" })).status).toBe(400);
    expect(
      (await postJson(route, route, { junk: "x".repeat(20_000) }, { "idempotency-key": "k" })).status,
    ).toBe(413);

    expect(
      (await get(`/wagering/transactions/${transactionId}`, "/wagering/transactions/{transactionId}")).status,
    ).toBe(200);
    expect(
      (await get(`/wagering/transactions/${randomUUID()}`, "/wagering/transactions/{transactionId}")).status,
    ).toBe(404);
    expect(
      (await get("/wagering/transactions/not-a-uuid", "/wagering/transactions/{transactionId}")).status,
    ).toBe(400);
    const external = "/providers/{providerId}/wagering/transactions/{externalTransactionId}";
    expect(
      (await get(`/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`, external))
        .status,
    ).toBe(200);
    expect((await get(`/providers/${bet.providerId}/wagering/transactions/missing`, external)).status).toBe(
      404,
    );
    // A control character in an id is refused at the edge: it would otherwise reach PostgreSQL and come back as a 500.
    expect((await get(`/providers/${bet.providerId}/wagering/transactions/bad%01id`, external)).status).toBe(
      400,
    );
  });

  test("every answer carries the security headers, errors, refusals and unknown routes included", async () => {
    const wallet = await world.openWallet("10.00");
    const expected = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    };
    const answers = [
      await call(`${app.url}/wallets/${wallet.walletId}`),
      await call(`${app.url}/wallets/${randomUUID()}`),
      await call(`${app.url}/wallets/not-a-uuid`),
      await call(`${app.url}/no/such/route`),
      await call(`${app.url}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      await call(`${app.url}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ junk: "x".repeat(20_000) }),
      }),
      await call(`${app.url}/health/live`),
      await call(`${app.url}/health/ready`),
      await call(`${app.url}/metrics`),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 404, 400, 404, 400, 413, 200, 200, 200]);
    for (const [index, answer] of answers.entries()) {
      for (const [name, value] of Object.entries(expected)) {
        expect(answer.headers.get(name), `${name} on answer ${index} (${answer.status})`).toBe(value);
      }
      expect(answer.headers.get("strict-transport-security")).toBeNull();
      // The same gap hid the correlation id of what the body parser refuses (FR-65).
      expect(answer.headers.get("x-correlation-id"), `x-correlation-id on answer ${index}`).toBeTruthy();
    }

    const behindTls = await call(`${app.url}/health/live`, { headers: { "x-forwarded-proto": "https" } });
    expect(behindTls.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("health and metrics", async () => {
    for (const [path, status] of [
      ["/health/live", 200],
      ["/health/ready", 200],
      ["/metrics", 200],
    ] as const) {
      const response = await call(`${app.url}${path}`);
      expect(response.status).toBe(status);
      await check("GET", path, response.clone() as unknown as Response);
    }
  });

  test("the unreachable statuses are declared and the reachable ones were all exercised", () => {
    // 503 and 500 need a failing dependency; they are exercised by the integration suites and asserted there. Every
    // other status the spec declares was met above, so a documented response nobody can get cannot stay in the spec.
    const unreachableHere = new Set(["503", "500"]);
    const unexercised = operations.flatMap(({ method, path, op }) =>
      Object.keys(op.responses)
        .filter((status) => !unreachableHere.has(status) && !seen.has(`${method} ${path} ${status}`))
        .map((status) => `${method} ${path} ${status}`),
    );
    expect(unexercised).toEqual([]);
  });
});
