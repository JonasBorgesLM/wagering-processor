import type { EntitySchema } from "@mikro-orm/postgresql";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { createOrmConfig } from "./mikro-orm.config";

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /** The entities come from whoever composes the application: platform may not import business code. */
  static forRoot(entities: EntitySchema[]): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: MikroORM,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            MikroORM.init(createOrmConfig(config.databaseUrl, "migrations", entities)),
        },
      ],
      exports: [MikroORM],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
