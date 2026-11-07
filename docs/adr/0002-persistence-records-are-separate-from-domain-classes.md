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

## Amendment (implementation of issue #11)

Nothing above is superseded. What building it settled:

- **The records are interfaces, not classes.** `EntitySchema` accepts a `name` with no class, so a record is a plain object and has no constructor to bypass or to loosen. A loaded record is an ORM entity and not a plain object, so the mappers read properties and always return domain classes.
- **Amounts are exact because of the column type.** With `numeric(20,2)` the ORM maps the property to its decimal type and reads a string. Declaring the property as a number changes nothing, which was checked, so the declared type is documentation and a test pins the resolved one against the database.
- **`updated_at` is supplied by whoever writes the row.** The domain's transaction has no such field (the README gives it none), so `transactionToRecord` takes it as an argument. That is where the time of a rejection is kept.
- **The ORM's entities are passed in.** `createOrmConfig` takes them as a parameter, because `platform` may not import business code.
- **A stored value the code does not recognise is an error.** Mappers throw `PersistenceMappingError` instead of carrying an unknown kind, status or code into the domain, which would mean the schema and the code have drifted.

