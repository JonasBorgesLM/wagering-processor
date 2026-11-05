import { randomUUID } from "node:crypto";

/** Short and plain on purpose: this value is echoed in a response header and written to logs. */
const ACCEPTABLE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface CorrelatedResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Ties one request to its log lines and events. A caller's own id is kept when
 * it is plain, and replaced when it is not: an arbitrary header value reflected
 * into a response header or a log line is how an injection gets in.
 */
export function correlationMiddleware(
  request: CorrelatedRequest,
  response: CorrelatedResponse,
  next: () => void,
): void {
  const supplied = request.headers["x-correlation-id"];
  const id = typeof supplied === "string" && ACCEPTABLE.test(supplied) ? supplied : randomUUID();
  request.correlationId = id;
  response.setHeader("X-Correlation-Id", id);
  next();
}
