import type { DomainError } from "./errors";

type ErrorType = new (message: string) => DomainError;

export function assertText(value: unknown, name: string, error: ErrorType): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new error(`${name} must be a non-empty string`);
}

export function assertDate(value: unknown, name: string, error: ErrorType): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new error(`${name} must be a valid date`);
}
