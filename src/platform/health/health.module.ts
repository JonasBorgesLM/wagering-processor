import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Inject, Module, ServiceUnavailableException } from "@nestjs/common";
import { QUEUES } from "../config/config";
import { DrainState } from "../lifecycle/drain-state";
import { databaseProbe, PROBE_TIMEOUT_MS, probe } from "./probe";

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
      databaseProbe(this.orm)(),
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

@Module({ controllers: [HealthController] })
export class HealthModule {}
