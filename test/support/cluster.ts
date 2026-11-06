import { eventually } from "./consumer-harness";
import { TEST_ENV } from "./env";
import type { SettlementWorld } from "./settlement";

export interface ClusterProcess {
  readonly child: Bun.Subprocess;
  readonly url: string;
  readonly roles: string;
  /** Everything the process has written to its output so far. */
  output(): string;
  kill(signal: NodeJS.Signals): Promise<number>;
}

/**
 * Real application processes, as `bun run src/main.ts`, sharing one database and one broker. The failure suite uses
 * them because what it proves (a kill, a restart, a second instance taking over) does not exist inside one process.
 */
export class Cluster {
  private readonly started: ClusterProcess[] = [];

  constructor(private readonly world: SettlementWorld) {}

  /** Short polls and intervals, long locks and a wide pool: so a held lock is waited on and not given up. */
  async start(roles: string, env: Record<string, string> = {}): Promise<ClusterProcess> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = Bun.spawn(["bun", "run", "src/main.ts"], {
      env: {
        ...process.env,
        ...TEST_ENV,
        DATABASE_URL: this.world.databaseUrl(),
        PORT: String(port),
        APP_ROLES: roles,
        QUEUE_WAIT_SECONDS: "1",
        OUTBOX_POLL_INTERVAL_MS: "100",
        OUTBOX_LEASE_MS: "2000",
        REFERENCE_POLL_INTERVAL_MS: "200",
        REFERENCE_RETRY_BASE_SECONDS: "1",
        REFERENCE_RETRY_CAP_SECONDS: "2",
        LOCK_TIMEOUT_MS: "60000",
        STATEMENT_TIMEOUT_MS: "60000",
        DATABASE_POOL_MAX: "30",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let collected = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>)
        collected += decoder.decode(chunk);
    })();
    const url = `http://localhost:${port}`;
    const proc: ClusterProcess = {
      child,
      url,
      roles,
      output: () => collected,
      kill: async (signal) => {
        child.kill(signal);
        return child.exited;
      },
    };
    this.started.push(proc);
    await eventually(
      async () => (await fetch(`${url}/health/ready`).catch(() => undefined))?.status === 200,
      `a process with roles ${roles} to be ready`,
      30_000,
    );
    return proc;
  }

  async stopAll(): Promise<void> {
    for (const proc of this.started.splice(0)) {
      if (proc.child.exitCode === null) {
        proc.child.kill("SIGKILL");
        await proc.child.exited;
      }
    }
  }
}
