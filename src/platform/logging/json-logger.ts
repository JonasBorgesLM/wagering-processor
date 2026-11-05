import type { LoggerService } from "@nestjs/common";

/** Anything else passed as log context is dropped: an allowlist cannot leak a field nobody thought of (SR-01). */
const ALLOWED_FIELDS = [
  "correlationId",
  "messageId",
  "transactionId",
  "walletId",
  "providerId",
  "failureCode",
  "status",
  "durationMs",
  "error",
] as const;

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "verbose";

export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.emit("info", message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit("error", message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit("warn", message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit("verbose", message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit("fatal", message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      message: typeof message === "string" ? message : undefined,
    };
    // Nest passes the logger name as the last string argument.
    const context = rest.findLast((value) => typeof value === "string");
    if (context) entry.context = context;
    for (const source of [message, ...rest]) {
      if (typeof source !== "object" || source === null) continue;
      for (const field of ALLOWED_FIELDS) {
        const value = (source as Record<string, unknown>)[field];
        if (value !== undefined) entry[field] = value;
      }
    }
    this.write(JSON.stringify(entry));
  }
}
