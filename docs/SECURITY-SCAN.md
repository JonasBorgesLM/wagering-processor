# Security scan

A black-box scan of the running API with [warden](https://github.com/JonasBorgesLM/warden), the owner's own API security scanner, run against this service's local stack. It found a real gap in the response headers, which is fixed, and its coverage has limits that are listed here and not hidden.

## How to run it

```bash
docker compose up -d --wait postgres sqs && bun run provision
WARDEN_SRC=/path/to/warden ./scripts/security-scan.sh      # or WARDEN=/path/to/a/built/binary
```

`scripts/security-scan.sh` creates a throwaway database, seeds it through the real use cases with the rows that `docs/openapi.yaml` names in its examples (`scripts/seed-scan.ts`), starts one instance on `127.0.0.1:3099`, runs `warden scan`, `attack` and `report` with `security/warden.yaml`, writes the results to `security-results/` (not committed) and removes the database. Warden imports the routes from `docs/openapi.yaml`. Its `scope.allowed_hosts` is the one loopback address: a request to any other host is refused before it leaves the process. **Active checks send hostile input and `test_creates` sends bodies to POST routes; point it only at a target you own.**

## What was run

Warden at `b071131`, twelve checks enabled: `missing-headers`, `exposed-secrets`, `sqli-boolean`, `xss-reflected`, `auth-required`, `cache-on-authenticated`, `cors-misconfigured`, `dangerous-http-methods`, `idor`, `jwt-weak`, `verbose-errors`, `open-redirect`. 61 checks over the 10 routes.

## Findings and what was done with each

| First run | Check | Triage |
| --- | --- | --- |
| 7 routes | `missing-headers`: `X-Content-Type-Options` (medium) | **Fixed.** A browser could sniff a JSON body as a script or markup. |
| 7 routes | `missing-headers`: `X-Frame-Options`, `Content-Security-Policy` (low) | **Fixed.** Nothing here is a page, so nothing may load or be framed. |
| 7 routes | `missing-headers`: `Strict-Transport-Security` (medium) | **Fixed where it applies, accepted where it does not.** The process speaks plain HTTP behind whatever terminates TLS, and a browser ignores the header over HTTP. It is now sent on a request that arrived over TLS (directly, or by `X-Forwarded-Proto: https`) and tested. The scan runs over plain HTTP, so the 7 findings remain, and are accepted for that reason. TLS is the deployment's (THREAT-MODEL section 7). |

First run: 28 findings. After the fix: **7, all the HSTS finding over plain HTTP.**

Also added, without a finding asking for it: `Referrer-Policy: no-referrer` (paths carry wallet and transaction ids) and `Cache-Control: no-store` (the answers are balances and ledgers).

**A second gap, found by the test written for the first:** what the body parser refuses (malformed JSON, a body over the limit) was answered before the security-headers and correlation middleware ran, so those `400` and `413` answers had neither the headers nor an `X-Correlation-Id` (FR-65 promised it on every response). Both middlewares now run before the parser, and the test checks every kind of answer, error and unknown route included.

## What it examined and found nothing

46 checks examined with no finding, among them `sqli-boolean`, `xss-reflected` and `verbose-errors` on the routes that take an id (with seeded rows, so the scanner's benign request is answered 200 and an injected one can be compared with it), `dangerous-http-methods` (no `TRACE`), `exposed-secrets`, and `cors-misconfigured` (no CORS headers, which is the secure state). Nothing was confirmed by the `attack` stage because nothing was left to confirm but the HSTS header.

## What the scan did not cover

15 checks were skipped, each with warden's own reason:

- **`sqli-boolean` and `xss-reflected` on the POST routes and on the ledger's `cursor`:** the scanner's benign value is refused at the edge (`400`: not a UUID, not a valid cursor), so an injected value could not reach a query either. This is the strict validation working; it also means those parameters were not probed past the edge.
- **`missing-headers`, `exposed-secrets` and `cors-misconfigured` on the POST routes:** warden collects its baseline with a safe method, so it never saw those routes' own answers. The security headers are a middleware on every response, and a test of ours checks them on POST answers and errors directly.
- **`auth-required`, `idor`, `jwt-weak`:** there is nothing to test. The spec declares no protected route, because none is protected, so `auth-required` has no route to check. This is the known, largest open risk (T-06, ADR-0009): the scan did not find the absence of authentication because the spec, truthfully, does not claim it.
- **`open-redirect`:** no route takes a redirect-shaped parameter.

## Limits

One run, on loopback, against a seeded throwaway database, with the checks warden has today. A scan finds what it looks for; it is not a penetration test, and a clean result on injection means the parameters it reached did not misbehave, not that none can. It does not test denial of service (see [`STRESS-TEST.md`](STRESS-TEST.md)), authentication, or anything behind a network boundary.
