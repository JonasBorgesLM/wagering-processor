/** Defaults match docker-compose.yml, so tests run with no setup beyond `docker compose up`. */
export const TEST_ENV = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5433/wagering",
  AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
};
