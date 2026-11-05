import { Module } from "@nestjs/common";
import { ConfigModule } from "./platform/config/config.module";
import { DatabaseModule } from "./platform/database/database.module";
import { HealthModule } from "./platform/health/health.module";
import { SqsModule } from "./platform/messaging/sqs.module";
import { MetricsModule } from "./platform/metrics/metrics.module";

@Module({ imports: [ConfigModule, DatabaseModule, SqsModule, MetricsModule, HealthModule] })
export class AppModule {}
