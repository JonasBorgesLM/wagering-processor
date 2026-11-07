import { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({ region: config.awsRegion, endpoint: config.sqsEndpoint }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
