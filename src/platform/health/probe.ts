import type { MikroORM } from "@mikro-orm/postgresql";

export const PROBE_TIMEOUT_MS = 2_000;

/** Whether a dependency answers within the probe timeout. Never throws: down is an answer. */
export async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    return "up";
  } catch {
    return "down";
  }
}

/** The check readiness reports as `postgres`, and the one the consumer waits on before it receives (issue #52). */
export const databaseProbe = (orm: MikroORM) => () => probe(() => orm.em.getConnection().execute("select 1"));
