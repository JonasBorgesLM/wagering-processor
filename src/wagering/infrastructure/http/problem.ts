import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  ForbiddenException,
  HttpException,
  type LoggerService,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  type RequestIssue,
  SettlementFailedError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import { DomainError } from "../../domain/errors";

/** How long a provider should wait before resending after a transient failure. Short, because nothing was committed. */
export const RETRY_AFTER_SECONDS = 1;

export interface Problem {
  status: number;
  headers: Record<string, string>;
  body: { error: { code: string; message: string; details?: readonly RequestIssue[] } };
}

/**
 * The one place that decides what an error means to a caller, so the same
 * situation has the same status on every endpoint. A provider decides whether
 * to resend, fix the payload or give up from the status alone:
 *
 * - 400: the request is wrong; resending it cannot work
 * - 404: no such wallet or route
 * - 409: it conflicts with something that exists; resending it cannot work
 * - 503: nothing was committed and trying again may work (with Retry-After)
 * - 500: a bug; the cause is logged and never sent
 *
 * A business rejection is not an error and is not here: it is a result.
 */
export function toProblem(error: unknown): Problem {
  const problem = (status: number, code: string, message: string, extra: Partial<Problem> = {}): Problem => ({
    status,
    headers: extra.headers ?? {},
    body: {
      error: { code, message, ...(extra.body?.error.details ? { details: extra.body.error.details } : {}) },
    },
  });

  if (error instanceof InvalidRequestError) {
    return {
      status: 400,
      headers: {},
      body: { error: { code: error.code, message: "the request is not valid", details: error.issues } },
    };
  }
  if (error instanceof WalletNotFoundError) return problem(404, error.code, "no such wallet");
  if (error instanceof TransactionNotFoundError) return problem(404, error.code, "no such transaction");
  // Terminal and not the provider's doing, so neither a 4xx nor a 503: asking again returns the same answer.
  if (error instanceof SettlementFailedError) {
    return problem(
      500,
      error.code,
      "this transaction could not be settled and will not be retried; send it again under a new id",
    );
  }
  if (error instanceof WalletAlreadyExistsError) {
    return problem(409, error.code, "this player already has a wallet in this currency");
  }
  if (error instanceof IdempotencyConflictError) {
    return problem(409, error.code, "this Idempotency-Key was already used with a different payload");
  }
  if (error instanceof ExternalIdConflictError) {
    return problem(409, error.code, "this provider transaction already exists under another Idempotency-Key");
  }
  if (error instanceof TransientFailureError) {
    return problem(503, "TRANSIENT_FAILURE", "temporarily unavailable; nothing was changed, try again", {
      headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
    });
  }
  // The domain refusing a value the edge did not catch is still the caller's mistake.
  if (error instanceof DomainError) return problem(400, "VALIDATION_ERROR", error.message);

  const status = httpStatusOf(error);
  if (status === 413) return problem(413, "PAYLOAD_TOO_LARGE", "the request body is too large");
  if (status === 404) return problem(404, "NOT_FOUND", "no such route");
  if (status === 401) return problem(401, "UNAUTHORIZED", "authentication is required");
  if (status === 403) return problem(403, "FORBIDDEN", "this caller is not allowed to do that");
  if (status === 415) return problem(415, "UNSUPPORTED_MEDIA_TYPE", "the content type is not supported");
  if (status === 400) return problem(400, "VALIDATION_ERROR", "the request body is not valid JSON");
  if (status !== undefined && status >= 400 && status < 500)
    return problem(status, "REQUEST_REJECTED", "the request was rejected");

  return problem(500, "INTERNAL_ERROR", "an unexpected error occurred");
}

/** Errors that already carry an HTTP status: Nest's own, and the body parser's. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate =
    (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === "number" ? candidate : undefined;
}

interface HttpResponse {
  headersSent: boolean;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

interface HttpRequest {
  correlationId?: string;
}

/**
 * Framework exceptions that get the envelope: an unknown route is a caller's mistake like any other, and a guard's
 * refusal has to look the same as every other refusal. Any other `HttpException` keeps its own body.
 */
function isEnveloped(exception: HttpException): boolean {
  return (
    exception instanceof NotFoundException ||
    exception instanceof UnauthorizedException ||
    exception instanceof ForbiddenException
  );
}

/** Writes the answer for an error. Shared by the filter and the middleware below, so both answer the same way. */
function respond(
  exception: unknown,
  request: HttpRequest,
  response: HttpResponse,
  logger: LoggerService,
): void {
  // An HttpException carries its own status and body on purpose: the readiness endpoint answers 503 with which
  // dependency is down, and a monitor reads that. This envelope is for the business endpoints. An unknown route
  // is the exception, since it is a caller's mistake like any other.
  if (exception instanceof HttpException && !isEnveloped(exception)) {
    if (!response.headersSent) response.status(exception.getStatus()).json(exception.getResponse());
    return;
  }

  const problem = toProblem(exception);

  if (problem.status >= 500) {
    // Only here is the cause logged, and only here: it is never part of the response. A transient failure is
    // worth knowing about but is not a bug, so it is a warning and a bug is an error.
    const cause =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`.slice(0, 500)
        : String(exception).slice(0, 500);
    const fields = { correlationId: request.correlationId, status: problem.status, error: cause };
    if (problem.status === 503) logger.warn("Request failed", fields);
    else logger.error("Request failed", fields);
  } else {
    // A refusal is the caller's mistake and not ours, so it is information and not a warning. Only the code is
    // logged: the message can carry the key or the ids the caller sent (SR-01), and the code says what happened.
    logger.log("Request refused", {
      correlationId: request.correlationId,
      status: problem.status,
      error: problem.body.error.code,
    });
  }
  if (response.headersSent) return;
  for (const [name, value] of Object.entries(problem.headers)) response.setHeader(name, value);
  response.status(problem.status).json(problem.body);
}

/** Errors raised inside a controller reach this through Nest. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    respond(exception, context.getRequest<HttpRequest>(), context.getResponse<HttpResponse>(), this.logger);
  }
}

/**
 * Errors raised before a controller is reached, which Nest's filters never see: the body parser rejecting
 * malformed JSON or a body over the limit. Express recognises an error handler by its four parameters, so the
 * arity here is what makes this one, and it must be registered after the parser it covers.
 */
export function problemMiddleware(logger: LoggerService) {
  return (error: unknown, request: HttpRequest, response: HttpResponse, _next: () => void): void => {
    respond(error, request, response, logger);
  };
}
