import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  ServiceUnavailableException,
} from "@nestjs/common";
import { QUEUES } from "../config/config";

const PROBE_TIMEOUT_MS = 2_000;

/** Flips before connections close, so a load balancer stops routing here while in-flight work finishes (FR-80). */
@Injectable()
class DrainState implements BeforeApplicationShutdown {
  draining = false;
  private readonly logger = new Logger(DrainState.name);

  beforeApplicationShutdown(signal?: string): void {
    this.draining = true;
    this.logger.log(`Draining after ${signal ?? "shutdown request"}`);
  }
}

@Controller("health")
class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(DrainState) private readonly drain: DrainState,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<Record<string, unknown>> {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.getConnection().execute("select 1")),
      probe(() =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.input }), {
          abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
      ),
    ]);
    const body = { draining: this.drain.draining, postgres, sqs };
    if (this.drain.draining || postgres !== "up" || sqs !== "up") {
      throw new ServiceUnavailableException({ status: "unavailable", ...body });
    }
    return { status: "ok", ...body };
  }
}

async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    return "up";
  } catch {
    return "down";
  }
}

@Module({ controllers: [HealthController], providers: [DrainState] })
export class HealthModule {}
