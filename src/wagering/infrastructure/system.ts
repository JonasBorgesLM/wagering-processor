import type { Clock, IdGenerator } from "../application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: time-ordered, so new primary keys land together in the index instead of scattering across it. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
