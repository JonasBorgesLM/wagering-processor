interface HeaderRequest {
  secure?: boolean;
  headers: Record<string, string | string[] | undefined>;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Response headers for an API that returns data and never a document. Found missing by the security scan (issue #59),
 * and each answers a way a browser or a cache could misuse a JSON response:
 *
 * - `X-Content-Type-Options: nosniff`: a browser must not guess that a JSON body is a script or markup.
 * - `Content-Security-Policy` and `X-Frame-Options`: nothing here is a page, so nothing may load or be framed.
 * - `Referrer-Policy: no-referrer`: the paths carry wallet and transaction ids, which must not leak in a `Referer`.
 * - `Cache-Control: no-store`: the answers are balances and ledgers; no cache, shared or not, keeps them.
 * - `Strict-Transport-Security`: only on a request that arrived over TLS. This process speaks plain HTTP behind
 *   whatever terminates TLS, and the header is ignored over HTTP, so it is sent when the request says it was
 *   secure (directly, or by the proxy's `X-Forwarded-Proto`). A caller can only set it on its own response.
 *
 * Set before anything else runs, so an error, a refusal and a `404` carry them too.
 */
export function securityHeadersMiddleware(
  request: HeaderRequest,
  response: HeaderResponse,
  next: () => void,
): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  const forwarded = request.headers["x-forwarded-proto"];
  if (request.secure === true || forwarded === "https") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}
