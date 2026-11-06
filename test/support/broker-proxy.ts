import { TEST_ENV } from "./env";

export interface HeldRequest {
  action: string;
  body: Record<string, unknown>;
}

/**
 * A forwarding proxy in front of the real broker, that holds chosen requests forever. It is how a test puts a real
 * process at an exact point of its work and keeps it there: hold the acknowledgement and the process has committed
 * and not acknowledged; hold the publish and it has claimed and not published. A kill at that moment is not a race
 * to win but a state to find, so the test is the same on every run and on every machine.
 *
 * Everything else goes through to the real broker unchanged, so nothing here is a stand-in for it. The queue urls
 * the broker hands out name its own address, so they are rewritten to the proxy's, or the client would walk around it.
 */
export class BrokerProxy {
  readonly held: HeldRequest[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;

  private constructor(private readonly shouldHold: (request: HeldRequest) => boolean) {
    const upstream = TEST_ENV.SQS_ENDPOINT;
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const text = await request.text();
        const action = (request.headers.get("x-amz-target") ?? "").replace("AmazonSQS.", "");
        const body = text
          ? (JSON.parse(text.replaceAll(this.origin, upstream)) as Record<string, unknown>)
          : {};

        if (this.shouldHold({ action, body })) {
          this.held.push({ action, body });
          // Never answered: the process is killed while it waits, which is the point.
          return new Promise<Response>(() => undefined);
        }

        const headers = new Headers(request.headers);
        headers.delete("host");
        const answer = await fetch(upstream + url.pathname + url.search, {
          method: request.method,
          headers,
          body: text ? text.replaceAll(this.origin, upstream) : undefined,
        });
        return new Response((await answer.text()).replaceAll(upstream, this.origin), {
          status: answer.status,
          headers: { "content-type": answer.headers.get("content-type") ?? "application/json" },
        });
      },
    });
  }

  static start(shouldHold: (request: HeldRequest) => boolean): BrokerProxy {
    return new BrokerProxy(shouldHold);
  }

  get origin(): string {
    return `http://localhost:${this.server.port}`;
  }

  heldCount(action: string): number {
    return this.held.filter((request) => request.action === action).length;
  }

  stop(): void {
    this.server.stop(true);
  }
}
