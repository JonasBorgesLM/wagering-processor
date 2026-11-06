import { type DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "./platform/config/config";
import { ConfigModule } from "./platform/config/config.module";
import { DatabaseModule } from "./platform/database/database.module";
import { HealthModule } from "./platform/health/health.module";
import { LifecycleModule } from "./platform/lifecycle/drain-state";
import { SqsModule } from "./platform/messaging/sqs.module";
import { MetricsModule } from "./platform/metrics/metrics.module";
import { wageringEntitySchemas } from "./wagering/infrastructure/persistence/schemas";
import { WageringModule } from "./wagering/infrastructure/wagering.module";

/** The composition root: the one place that knows both the platform and the business code. */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule.forRoot(wageringEntitySchemas),
        LifecycleModule,
        SqsModule,
        MetricsModule,
        HealthModule,
        WageringModule.register({
          api: config.roles.has("api"),
          consumer: config.roles.has("consumer"),
          publisher: config.roles.has("publisher"),
        }),
      ],
    };
  }
}
