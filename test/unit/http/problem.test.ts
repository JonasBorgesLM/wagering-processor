import { describe, expect, test } from "bun:test";
import {
  type ArgumentsHost,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DuplicateOperationError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../src/wagering/application/errors";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../../src/wagering/domain/errors";
import {
  ProblemFilter,
  RETRY_AFTER_SECONDS,
  toProblem,
} from "../../../src/wagering/infrastructure/http/problem";

// "Colapsar essas situações em um mesmo código obriga o provedor a interpretar mensagem de erro" (§9).
// One table, so the whole mapping is visible at once and two situations cannot quietly share a status.

describe("every situation has its own status and code", () => {
  const cases: Array<[string, unknown, number, string]> = [
    ["an invalid request", new InvalidRequestError([{ field: "x", reason: "bad" }]), 400, "VALIDATION_ERROR"],
    ["a domain rule the edge did not catch", new InvalidMoneyError("bad amount"), 400, "VALIDATION_ERROR"],
    [
      "a transaction that is malformed as built",
      new InvalidWagerTransactionError("no reference"),
      400,
      "VALIDATION_ERROR",
    ],
    ["a wallet that does not exist", new WalletNotFoundError("x"), 404, "WALLET_NOT_FOUND"],
    ["a duplicate wallet", new WalletAlreadyExistsError("x"), 409, "WALLET_ALREADY_EXISTS"],
    ["a key reused with another payload", new IdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
    ["an operation under another key", new ExternalIdConflictError("x"), 409, "EXTERNAL_ID_CONFLICT"],
    ["a transient failure", new TransientFailureError("x"), 503, "TRANSIENT_FAILURE"],
    [
      "a body parser: too large",
      Object.assign(new Error("too big"), { status: 413, type: "entity.too.large" }),
      413,
      "PAYLOAD_TOO_LARGE",
    ],
    [
      "a body parser: not JSON",
      Object.assign(new Error("bad json"), { status: 400, type: "entity.parse.failed" }),
      400,
      "VALIDATION_ERROR",
    ],
    ["a route that does not exist", new NotFoundException(), 404, "NOT_FOUND"],
    [
      "an unsupported media type",
      Object.assign(new Error("x"), { statusCode: 415 }),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    ["any other 4xx", Object.assign(new Error("x"), { status: 418 }), 418, "REQUEST_REJECTED"],
    ["a bug", new Error("boom"), 500, "INTERNAL_ERROR"],
    ["something that is not even an error", "a string was thrown", 500, "INTERNAL_ERROR"],
  ];

  test.each(cases)("%s", (_name, error, status, code) => {
    const problem = toProblem(error);
    expect(problem.status).toBe(status);
    expect(problem.body.error.code).toBe(code);
  });

  test("no two business situations share a status and a code", () => {
    const keys = cases.map(([, error]) => {
      const { status, body } = toProblem(error);
      return `${status} ${body.error.code}`;
    });
    // The generic ones legitimately repeat (several errors are a VALIDATION_ERROR). The distinct business ones must not.
    const business = cases.filter(([name]) => /wallet|key|operation|transient/.test(name));
    const businessKeys = business.map(
      ([, error]) => `${toProblem(error).status} ${toProblem(error).body.error.code}`,
    );
    expect(new Set(businessKeys).size).toBe(business.length);
    expect(keys.length).toBe(cases.length);
  });

  test("the three kinds a provider acts on differently are three different statuses", () => {
    const rejected = toProblem(new InvalidRequestError([])).status;
    const conflict = toProblem(new IdempotencyConflictError("x")).status;
    const transient = toProblem(new TransientFailureError("x")).status;
    expect(new Set([rejected, conflict, transient]).size).toBe(3);
  });
});

describe("what the body carries", () => {
  test("the envelope is { error: { code, message } }", () => {
    expect(toProblem(new WalletNotFoundError("x")).body).toEqual({
      error: { code: "WALLET_NOT_FOUND", message: "no such wallet" },
    });
  });

  test("a validation error lists every issue", () => {
    const issues = [
      { field: "a", reason: "one" },
      { field: "b", reason: "two" },
    ];
    expect(toProblem(new InvalidRequestError(issues)).body.error.details).toEqual(issues);
  });

  test("only a validation error has details", () => {
    expect(toProblem(new WalletAlreadyExistsError("x")).body.error).not.toHaveProperty("details");
  });

  // The message is written for a caller, not copied from the error, so internals cannot leak through it.
  test("a message from inside is never copied into the response", () => {
    const secrets = [
      new WalletNotFoundError("wallet 0192f28f-5dc0 does not exist"),
      new WalletAlreadyExistsError(
        'duplicate key value violates unique constraint "uq_wallets_player_currency" Key (player_id)=(secret)',
      ),
      new TransientFailureError("connect ECONNREFUSED 10.0.0.5:5432"),
      new Error("select * from wallets where password = 'hunter2'"),
    ];
    for (const error of secrets) {
      const body = JSON.stringify(toProblem(error).body);
      expect(body).not.toMatch(/0192f28f|uq_wallets|secret|10\.0\.0\.5|hunter2|select \*/);
    }
  });

  test("a bug gets a generic message and no stack", () => {
    const problem = toProblem(
      Object.assign(new Error("boom"), { stack: "at secretFunction (/home/app/x.ts:1)" }),
    );
    expect(JSON.stringify(problem.body)).not.toMatch(/boom|secretFunction|\/home/);
  });
});

describe("transient failures ask for a retry", () => {
  test("503 carries Retry-After", () => {
    expect(toProblem(new TransientFailureError("x")).headers).toEqual({
      "Retry-After": String(RETRY_AFTER_SECONDS),
    });
  });

  test("and nothing else does", () => {
    for (const error of [
      new InvalidRequestError([]),
      new WalletNotFoundError("x"),
      new IdempotencyConflictError("x"),
      new Error("boom"),
    ]) {
      expect(toProblem(error).headers).toEqual({});
    }
  });

  test("a duplicate-operation race never reaches a caller as its own status: the use case absorbs it", () => {
    // If it ever leaked, it must at least not look like a success or a conflict a provider would act on.
    expect(toProblem(new DuplicateOperationError("x")).status).toBe(500);
  });
});

describe("the filter", () => {
  function run(exception: unknown, options: { headersSent?: boolean } = {}) {
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const logged: unknown[][] = [];
    const warned: unknown[][] = [];
    const response = {
      headersSent: options.headersSent ?? false,
      status(code: number) {
        sent.status = code;
        return response;
      },
      setHeader(name: string, value: string) {
        sent.headers[name] = value;
      },
      json(body: unknown) {
        sent.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ correlationId: "corr-1" }) }),
    } as unknown as ArgumentsHost;
    const logger = {
      log() {},
      warn: (...args: unknown[]) => warned.push(args),
      error: (...args: unknown[]) => logged.push(args),
    };
    new ProblemFilter(logger).catch(exception, host);
    return { sent, logged, warned };
  }

  test("sends the status, headers and body of the problem", () => {
    const { sent } = run(new TransientFailureError("x"));
    expect(sent.status).toBe(503);
    expect(sent.headers["Retry-After"]).toBe("1");
    expect(sent.body).toEqual({
      error: {
        code: "TRANSIENT_FAILURE",
        message: "temporarily unavailable; nothing was changed, try again",
      },
    });
  });

  test("a bug is logged with the correlation id and the cause, and the response carries neither the cause", () => {
    const { sent, logged } = run(new Error("boom: password=hunter2"));
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain("hunter2");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toMatchObject({ correlationId: "corr-1", status: 500 });
    expect((logged[0]?.[1] as { error?: string } | undefined)?.error).toContain("boom");
  });

  test("a caller's mistake is not logged at all", () => {
    for (const error of [
      new WalletNotFoundError("x"),
      new InvalidRequestError([]),
      new IdempotencyConflictError("x"),
    ]) {
      const { logged, warned } = run(error);
      expect(logged).toEqual([]);
      expect(warned).toEqual([]);
    }
  });

  // Worth knowing about, since a lock that times out or a database that is down needs someone, but it is not a bug.
  test("a transient failure is a warning with the correlation id, not an error", () => {
    const { logged, warned } = run(new TransientFailureError("transient database failure (55P03)"));
    expect(logged).toEqual([]);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[1]).toMatchObject({ correlationId: "corr-1", status: 503 });
  });

  // The readiness endpoint answers 503 with which dependency is down, and a monitor reads that body.
  test("an HttpException keeps its own status and body", () => {
    const exception = new ServiceUnavailableException({ status: "unavailable", postgres: "down" });
    const { sent } = run(exception);
    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({ status: "unavailable", postgres: "down" });
  });

  test("including a 400 raised by the framework", () => {
    const { sent } = run(new BadRequestException("custom"));
    expect(sent.status).toBe(400);
  });

  test("except an unknown route, which gets the envelope like any caller's mistake", () => {
    const { sent } = run(new NotFoundException());
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: { code: "NOT_FOUND", message: "no such route" } });
  });

  test("writes nothing if the response has already started", () => {
    const { sent } = run(new WalletNotFoundError("x"), { headersSent: true });
    expect(sent.status).toBeUndefined();
    expect(sent.body).toBeUndefined();
  });
});
