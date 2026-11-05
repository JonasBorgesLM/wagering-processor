import { Controller, Get, Header, Inject, Module } from "@nestjs/common";
import { collectDefaultMetrics, Registry } from "prom-client";

@Controller("metrics")
class MetricsController {
  constructor(@Inject(Registry) private readonly registry: Registry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  expose(): Promise<string> {
    return this.registry.metrics();
  }
}

@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: Registry,
      useFactory: () => {
        const registry = new Registry();
        collectDefaultMetrics({ register: registry });
        return registry;
      },
    },
  ],
  exports: [Registry],
})
export class MetricsModule {}
