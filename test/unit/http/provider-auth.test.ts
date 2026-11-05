import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ProviderAuthGuard } from "../../../src/wagering/infrastructure/http/provider-auth.guard";
import { BUSINESS_CONTROLLERS, WageringModule } from "../../../src/wagering/infrastructure/wagering.module";

// ADR-0009: authentication is not implemented, and its place is. What would make that place worthless is a
// controller added without the guard, so this finds every controller in the code and checks each one.

const HTTP = resolve(import.meta.dir, "../../../src/wagering/infrastructure/http");

type Controller = abstract new (...args: never[]) => unknown;

async function controllersInTheCode(): Promise<Controller[]> {
  const found: Controller[] = [];
  for (const file of readdirSync(HTTP).filter((name) => name.endsWith(".controller.ts"))) {
    const module = (await import(join(HTTP, file))) as Record<string, unknown>;
    for (const exported of Object.values(module)) {
      if (typeof exported === "function" && Reflect.hasMetadata(PATH_METADATA, exported))
        found.push(exported as Controller);
    }
  }
  return found;
}

describe("the guard", () => {
  test("lets every request through, until a real check replaces it (SR-03)", () => {
    expect(new ProviderAuthGuard().canActivate()).toBe(true);
  });
});

describe("every business controller carries it", () => {
  test("there is at least one controller to check, so the scan cannot pass by finding nothing", async () => {
    expect((await controllersInTheCode()).length).toBeGreaterThanOrEqual(2);
  });

  test("each controller found in the code has the guard", async () => {
    for (const controller of await controllersInTheCode()) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined;
      expect(guards, `${controller.name} has no guard`).toContain(ProviderAuthGuard);
    }
  });

  test("and every one found is registered, so none is left unguarded by being unlisted", async () => {
    const inTheCode = new Set(await controllersInTheCode());
    expect(inTheCode).toEqual(new Set(BUSINESS_CONTROLLERS));
  });

  test("the module serves them only to a process with the api role (ADR-0001)", () => {
    expect(WageringModule.register({ api: true }).controllers).toEqual(BUSINESS_CONTROLLERS);
    expect(WageringModule.register({ api: false }).controllers).toEqual([]);
  });
});
