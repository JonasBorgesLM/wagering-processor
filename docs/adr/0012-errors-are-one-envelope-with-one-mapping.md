# ADR-0012: Errors are one envelope with one mapping, applied at two places

## Status
Accepted

## Context
Section 9 of the challenge asks the API to tell apart, consistently across every endpoint, an invalid payload, an idempotency conflict, a business rejection, an accepted-but-pending operation and a transient infrastructure failure. Collapsing them "forces the provider to read a message to decide whether it may resend".

Building the wallet endpoints exposed a second problem. The first version put the mapping in a NestJS exception filter, and the body parser's own errors (malformed JSON, a body over the limit) never reached it: they are raised in middleware, before any controller. The documented 400 and 413 were not being sent.

## Decision
- **One pure function, `toProblem`, decides what an error means to a caller.** Every business endpoint shares it, so one situation has one status.
- **The envelope is `{ "error": { "code", "message", "details"? } }`.** The provider branches on `code`. The message is written for the caller and is never copied from the error, so a driver message, a host name or a constraint name cannot leak. `details` lists every field problem of a 400.
- **It is applied in two places that call the same code:** a global filter for errors raised in controllers, and an Express error middleware, registered after the body parser, for errors raised before a controller is reached.
- **Platform endpoints keep their own contract.** An `HttpException` carries its own status and body: readiness answers `503` with which dependency is down, and a monitor reads that. An unknown route is the one exception, since it is a caller's mistake like any other.
- **The statuses:** `400` the request is wrong and resending cannot help; `404` no such wallet or route; `409` a conflict with something that exists; `413` over the limit; `503` with `Retry-After` when nothing was committed and trying again may work; `500` a bug, logged with the cause and sent without it.
- **A transient failure is logged as a warning and a bug as an error.** Both are worth knowing about, and only one is a defect.

## The alternative that was rejected
**A filter scoped to the wallet controller.** It leaves readiness alone without a special case. But it misses every error raised before routing, which is exactly the two (malformed JSON, oversized body) that a hostile or careless caller produces most.

**RFC 9457 `application/problem+json`.** It is the standard, and a gateway or client library may understand it. Its `type`, `title`, `status`, `detail` and `instance` add little for a provider that branches on a stable code, and the `details` list of field problems is an extension anyway. The cost of the envelope chosen is that it is not the standard.

**A different status per business reason.** A `422` for a rejection and a distinct status per failure code would let a client branch on status alone. The failure code is already the stable, documented discriminator, and a status per code multiplies the statuses a provider must handle.

## Consequences
- A new error class needs one line in `toProblem` and one row in the table that tests every mapping, which also checks that no two business situations share a status and a code.
- The two entry points can drift. A test sends a malformed body, an oversized one and `null` through the real application and expects the same envelope as a controller error.
- Some `HttpException`s from the framework are passed through as they are, with a body in a different shape. Today only readiness raises one, on purpose.

## Reopening criterion
A provider or gateway that requires `application/problem+json`, or a second platform endpoint that needs the envelope.
