export const ROLES = ["api", "consumer", "publisher", "reference-worker"] as const;
export type Role = (typeof ROLES)[number];

export const QUEUES = {
  input: "wager-transactions.fifo",
  deadLetter: "wager-transactions-dlq.fifo",
  events: "wagering-events.fifo",
} as const;

/** How many deliveries a message gets. The input queue's redrive policy is provisioned with the same number. */
export const MAX_RECEIVE_COUNT = 5;

export interface AppConfig {
  readonly port: number;
  readonly roles: ReadonlySet<Role>;
  readonly databaseUrl: string;
  readonly awsRegion: string;
  readonly sqsEndpoint: string;
  readonly shutdownTimeoutMs: number;
  /** How long a settlement waits for a wallet lock before giving up as a transient failure. See ARCHITECTURE.md. */
  readonly lockTimeoutMs: number;
  /** The longest any statement may run, including its lock wait, so nothing holds a connection indefinitely (NFR-11). */
  readonly statementTimeoutMs: number;
  /** Connections one process may hold. See ARCHITECTURE.md for why it is modest. */
  readonly databasePoolMax: number;
  /** How long a request waits for a free connection before giving up as a transient failure (NFR-11). */
  readonly databaseAcquireTimeoutMs: number;
  /** How long one poll of the input queue waits for a message. Also the longest stopping the consumer can take. */
  readonly queueWaitSeconds: number;
  /** The first retry of a failed message waits about this long; each further delivery doubles it (NFR-11). */
  readonly queueBackoffBaseSeconds: number;
  /** The longest a failed message waits. SQS allows 12 hours; a wallet's later messages wait behind it (T-10). */
  readonly queueBackoffCapSeconds: number;
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
    lockTimeoutMs: positiveInteger(env, "LOCK_TIMEOUT_MS", 2_000),
    statementTimeoutMs: positiveInteger(env, "STATEMENT_TIMEOUT_MS", 5_000),
    databasePoolMax: positiveInteger(env, "DATABASE_POOL_MAX", 10),
    databaseAcquireTimeoutMs: positiveInteger(env, "DATABASE_ACQUIRE_TIMEOUT_MS", 1_000),
    queueWaitSeconds: boundedInteger(env, "QUEUE_WAIT_SECONDS", 5, 20),
    queueBackoffBaseSeconds: positiveInteger(env, "QUEUE_BACKOFF_BASE_SECONDS", 2),
    queueBackoffCapSeconds: boundedInteger(env, "QUEUE_BACKOFF_CAP_SECONDS", 30, 43_200),
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

/** SQS refuses a wait over 20 seconds, so a larger value is a mistake to report now and not at the first poll. */
function boundedInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = positiveInteger(env, name, fallback);
  if (value > max) throw new InvalidConfigError(`${name} must be at most ${max}`);
  return value;
}

function parseRoles(raw: string | undefined): ReadonlySet<Role> {
  if (!raw) return new Set(ROLES);
  const roles = raw.split(",").map((role) => role.trim());
  for (const role of roles) {
    if (!ROLES.includes(role as Role)) throw new InvalidConfigError(`Unknown role in APP_ROLES: ${role}`);
  }
  return new Set(roles as Role[]);
}
