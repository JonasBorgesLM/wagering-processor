# ADR-0011: TypeScript stays on 6 until the boundary check supports 7

## Status
Accepted

## Context
The latest TypeScript was 7.0.2. `dependency-cruiser` 18 warned that it does not support it, analysed 0 modules, and reported no violations. The layer check would have passed forever while verifying nothing. Bun runs TypeScript directly, so the compiler version affects type checking only.

## Decision
Pin TypeScript 6.0.3. `check-boundaries.sh` reads the report and fails when no module was analysed or any violation exists.

## The alternative that was rejected
**Keeping TypeScript 7 and dropping the boundary check.** Faster type checks in exchange for an unchecked architecture rule, on a project scored for its boundaries. Reviews would then be the only guard.

## Consequences
- One major version behind, with slower type checks.

## Reopening criterion
A `dependency-cruiser` release that analyses modules correctly under TypeScript 7.
