# ADR-0004: Money is held as bigint minor units in the domain

## Status
Accepted

## Context
The challenge forbids `number` for money, fixes the scale at two decimals, and sketches `Money` around a `Decimal` value without requiring a library. The domain must depend on no framework.

## Decision
`Money` keeps a private `bigint` of minor units and a currency. It parses strings with a strict pattern and formats them back, with no float at any step. Addition and subtraction are exact, and no rounding path exists. In PostgreSQL the value is `numeric(20,2)`, which the driver returns as a string.

## The alternative that was rejected
**A decimal library** (`decimal.js`, `big.js`). It matches the challenge's sketch and handles arbitrary scales. Here it adds a dependency to the one layer meant to have none, and brings division and rounding modes this domain must never use. A fixed two-decimal scale needs neither.

## Consequences
- A currency with a different minor unit, such as `JPY`, would still be written with two decimals. The challenge fixes the scale, and only `BRL` is exercised.
- `bigint` does not serialize with `JSON.stringify`, so `toJSON()` must always return strings. That is what the contract wants.
- The money guard catches `parseFloat`, `Number(` and `number`-typed amounts in business code.

## Reopening criterion
A requirement for a currency with a scale other than two.
