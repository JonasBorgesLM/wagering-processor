import { type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { AppConfig } from "./platform/config/config";
import { correlationMiddleware } from "./wagering/infrastructure/http/correlation";
import { ProblemFilter, problemMiddleware } from "./wagering/infrastructure/http/problem";
import { securityHeadersMiddleware } from "./wagering/infrastructure/http/security-headers";

/** Requests are small JSON documents. The limit is a bound on what any caller can make us read (SR-04). */
export const BODY_LIMIT = "16kb";

/** Everything main does to build the application, so a test can build exactly the same one. */
export async function createApp(config: AppConfig, logger: LoggerService): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger,
    bodyParser: false,
  });
  app.disable("x-powered-by");
  // Before the body parser, so that what the parser refuses (malformed JSON, a body over the limit) carries the
  // security headers and a correlation id like any other answer. They were after it, and the security scan's headers
  // test found a 400 without them.
  app.use(securityHeadersMiddleware);
  app.use(correlationMiddleware);
  // Not strict: a body of `null` or `"text"` is valid JSON, so it should reach the validator and be told what is
  // expected, rather than be reported as malformed.
  app.useBodyParser("json", { limit: BODY_LIMIT, strict: false });
  // After the parser, whose errors Nest's filters never see.
  app.use(problemMiddleware(logger));
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  return app;
}
