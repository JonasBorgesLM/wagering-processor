import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { createOrmConfig } from "./mikro-orm.config";

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(createOrmConfig(config.databaseUrl)),
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
