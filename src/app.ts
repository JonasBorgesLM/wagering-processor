import { type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { AppConfig } from "./platform/config/config";
import { correlationMiddleware } from "./wagering/infrastructure/http/correlation";
import { ProblemFilter, problemMiddleware } from "./wagering/infrastructure/http/problem";

/** Requests are small JSON documents. The limit is a bound on what any caller can make us read (SR-04). */
export const BODY_LIMIT = "16kb";

/** Everything main does to build the application, so a test can build exactly the same one. */
export async function createApp(config: AppConfig, logger: LoggerService): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger,
    bodyParser: false,
  });
  app.disable("x-powered-by");
  // Not strict: a body of `null` or `"text"` is valid JSON, so it should reach the validator and be told what is
  // expected, rather than be reported as malformed.
  app.useBodyParser("json", { limit: BODY_LIMIT, strict: false });
  app.use(correlationMiddleware);
  // After the parser, whose errors Nest's filters never see.
  app.use(problemMiddleware(logger));
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  return app;
}
