# ADR-0002: MikroORM maps persistence records, and mappers build domain classes

## Status
Accepted

## Context
The challenge prefers MikroORM and requires domain classes with private constructors and `rehydrate` factories, free of ORM types. `EntitySchema` could map domain classes directly, keeping one set of classes.

Trying it on this stack: TypeScript rejects a private constructor in `EntitySchema` (`Cannot assign a 'private' constructor type`), and the ORM hydrates fields itself, bypassing `rehydrate`.

## Decision
`infrastructure/persistence` holds plain records mapped with `EntitySchema`, plus mappers to and from domain classes. Repositories take and return domain classes only. `Money` is stored as `numeric(20,2)` and a `char(3)` currency. Writes that need `ON CONFLICT` or conditions use explicit SQL inside the same transaction.

## The alternative that was rejected
**Mapping domain classes directly.** It is less code, with no mapper to keep in step. It requires loosening constructors and lets the Unit of Work flush mutated domain objects implicitly. In a system whose scoring centres on explicit transitions, an implicit flush is the wrong default.

**TypeORM.** Also accepted by the challenge, but its entities lean on decorators, and MikroORM's explicit `transactional()` and `LockMode` match the design better.

## Consequences
- A mapper per aggregate, and a test that round-trips each one.
- The Identity Map gives little here, since each transaction loads a wallet and a few rows.
- An entity manager is forked per transaction, so no state is shared between concurrent requests.

## Reopening criterion
Mappers becoming a recurring source of bugs measured in practice.
