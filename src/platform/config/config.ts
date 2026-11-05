export const ROLES = ["api", "consumer", "publisher", "reference-worker"] as const;
export type Role = (typeof ROLES)[number];

export const QUEUES = {
  input: "wager-transactions.fifo",
  deadLetter: "wager-transactions-dlq.fifo",
  events: "wagering-events.fifo",
} as const;

export interface AppConfig {
  readonly port: number;
  readonly roles: ReadonlySet<Role>;
  readonly databaseUrl: string;
  readonly awsRegion: string;
  readonly sqsEndpoint: string;
  readonly shutdownTimeoutMs: number;
}

export class InvalidConfigError extends Error {
  override readonly name = "InvalidConfigError";
}

/** Fails at startup, because an instance running with a bad value is worse than one that never started. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: positiveInteger(env, "PORT", 3000),
    roles: parseRoles(env.APP_ROLES),
    databaseUrl: required(env, "DATABASE_URL"),
    awsRegion: required(env, "AWS_REGION"),
    sqsEndpoint: required(env, "SQS_ENDPOINT"),
    shutdownTimeoutMs: positiveInteger(env, "SHUTDOWN_TIMEOUT_MS", 25_000),
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new InvalidConfigError(`${name} is required`);
  return value;
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new InvalidConfigError(`${name} must be a positive integer`);
  return Number(raw);
}

function parseRoles(raw: string | undefined): ReadonlySet<Role> {
  if (!raw) return new Set(ROLES);
  const roles = raw.split(",").map((role) => role.trim());
  for (const role of roles) {
    if (!ROLES.includes(role as Role)) throw new InvalidConfigError(`Unknown role in APP_ROLES: ${role}`);
  }
  return new Set(roles as Role[]);
}
