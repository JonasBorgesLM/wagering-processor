import { eventually } from "./consumer-harness";
import { TEST_ENV } from "./env";
import { freePort } from "./ports";
import type { SettlementWorld } from "./settlement";

export interface ClusterProcess {
  readonly child: Bun.Subprocess;
  readonly url: string;
  readonly roles: string;
  /** Everything the process has written to its output so far. */
  output(): string;
  /** Everything it has written to stderr so far. */
  errors(): string;
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
    const port = freePort();
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
    // Both streams are read for as long as the process lives. A pipe nobody reads fills up, and the process then
    // blocks on its next write; stderr is also where a runtime crash is reported, which stdout never shows.
    let collected = "";
    let errors = "";
    const drain = (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) append(decoder.decode(chunk));
      })();
    };
    drain(child.stdout as ReadableStream<Uint8Array>, (text) => {
      collected += text;
    });
    drain(child.stderr as ReadableStream<Uint8Array>, (text) => {
      errors += text;
    });
    const url = `http://localhost:${port}`;
    const proc: ClusterProcess = {
      child,
      url,
      roles,
      output: () => collected,
      errors: () => errors,
      kill: async (signal) => {
        child.kill(signal);
        return child.exited;
      },
    };
    this.started.push(proc);
    let lastReady = "no answer";
    const describe = () =>
      `stderr: ${errors.slice(-1500) || "(empty)"}; output: ${collected.slice(-1500) || "(empty)"}`;
    await eventually(
      async () => {
        // A process that died will never answer: say so at once, and why, instead of waiting out the timeout.
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `a process with roles ${roles} exited during start-up (code ${child.exitCode}, signal ${child.signalCode}); ${describe()}`,
          );
        }
        const answer = await fetch(`${url}/health/ready`).catch(() => undefined);
        lastReady = answer ? `${answer.status} ${await answer.text()}` : "no answer";
        return answer?.status === 200;
      },
      () => `a process with roles ${roles} to be ready; last answer: ${lastReady}; ${describe()}`,
      90_000,
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
