import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { AppConfig } from "./config";

export const APP_CONFIG = Symbol("APP_CONFIG");

/** The configuration is loaded once, at startup, and handed in: a module that read the environment itself could not be tested with another. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
