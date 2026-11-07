# ADR-0009: Authentication is a documented extension point, not implemented

## Status
Accepted

## Context
Section 2 of the challenge gives authentication no points, accepts omission if documented, and says it must not compete with financial correctness.

## Decision
No authentication now. The API module will carry a no-op `ProviderAuthGuard` as the explicit place for it. Health and metrics stay open, as the challenge requires for health.

**Intended design:** Keycloak in Compose, one OAuth 2.0 client-credentials client per provider, JWT validated at the guard against the realm's JWKS, and the token's provider claim compared with `providerId` in the payload. The queue stays an internal trusted channel.

## The alternative that was rejected
**Implementing Keycloak now.** It closes T-05, T-06, T-07 and T-12 in a real deployment. It takes time from 100 scored points for 0, and adds a heavy container to each test run.

## Consequences
- Anyone reaching the API can act as any provider (SR-03). It must not be exposed as is.
- The guard placement is decided, so adding this later does not touch settlement.

## Reopening criterion
All mandatory tests passing with time left, or any deployment beyond a private network.
