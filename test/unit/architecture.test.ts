import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The layer rules of .dependency-cruiser.cjs, run against a throwaway tree that breaks each of them once.
// check-boundaries.sh runs the same configuration on the real source, and has always said "no violations".
// A rule that has never been seen failing is a rule nobody knows works, so this makes each one fail on purpose.

const ROOT = resolve(import.meta.dir, "../..");
let workdir: string;

type Violation = { rule: string; from: string; to: string };
let violations: Violation[];
let analysed: number;

function write(relative: string, content: string) {
  const path = join(workdir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "architecture-"));
  symlinkSync(join(ROOT, "node_modules"), join(workdir, "node_modules"));
  writeFileSync(
    join(workdir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "bundler",
        target: "ESNext",
        types: [],
      },
      include: ["src"],
    }),
  );

  // The domain reaching out
  write("src/wagering/domain/clean.ts", "export const clean = 1;\n");
  write("src/wagering/domain/leaks-orm.ts", 'import "@mikro-orm/core";\nexport const a = 1;\n');
  write("src/wagering/domain/leaks-framework.ts", 'import "@nestjs/common";\nexport const b = 1;\n');
  write("src/wagering/domain/leaks-node.ts", 'import "node:crypto";\nexport const c = 1;\n');
  write(
    "src/wagering/domain/leaks-infrastructure.ts",
    'import { ok } from "../infrastructure/ok";\nexport const d = ok;\n',
  );
  write(
    "src/wagering/domain/leaks-application.ts",
    'import { fine } from "../application/fine";\nexport const e = fine;\n',
  );
  // The application reaching out
  write(
    "src/wagering/application/fine.ts",
    'import { clean } from "../domain/clean";\nimport "node:crypto";\nexport const fine = clean;\n',
  );
  write(
    "src/wagering/application/leaks-infrastructure.ts",
    'import { ok } from "../infrastructure/ok";\nexport const f = ok;\n',
  );
  write("src/wagering/application/leaks-orm.ts", 'import "@mikro-orm/core";\nexport const g = 1;\n');
  write("src/wagering/application/leaks-aws.ts", 'import "@aws-sdk/client-sqs";\nexport const h = 1;\n');
  write(
    "src/wagering/application/leaks-platform.ts",
    'import { p } from "../../platform/plumbing";\nexport const i = p;\n',
  );
  // Infrastructure may use anything: this is the control, and must stay clean
  write(
    "src/wagering/infrastructure/ok.ts",
    'import "@mikro-orm/core";\nimport "@nestjs/common";\nimport { clean } from "../domain/clean";\nimport { fine } from "../application/fine";\nexport const ok = clean + fine;\n',
  );
  // Platform knowing the business
  write("src/platform/plumbing.ts", "export const p = 1;\n");
  write(
    "src/platform/leaks-business.ts",
    'import { clean } from "../wagering/domain/clean";\nexport const j = clean;\n',
  );
  // A cycle
  write("src/wagering/domain/cycle-a.ts", 'import { b } from "./cycle-b";\nexport const a = 1 + b;\n');
  write("src/wagering/domain/cycle-b.ts", 'import { a } from "./cycle-a";\nexport const b = 1 + a;\n');

  const process = Bun.spawn(
    [
      join(ROOT, "node_modules/.bin/depcruise"),
      "src",
      "--config",
      join(ROOT, ".dependency-cruiser.cjs"),
      "--output-type",
      "json",
    ],
    { cwd: workdir, stdout: "pipe", stderr: "pipe" },
  );
  const report = JSON.parse(await new Response(process.stdout).text());
  await process.exited;
  analysed = report.summary.totalCruised;
  violations = report.summary.violations.map((v: { rule: { name: string }; from: string; to: string }) => ({
    rule: v.rule.name,
    from: v.from,
    to: v.to,
  }));
}, 60_000);

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const violating = (rule: string) =>
  [...new Set(violations.filter((v) => v.rule === rule).map((v) => v.from))].sort();

describe("the checker looked at the code", () => {
  // The failure this guards against: a tool that analyses nothing reports nothing.
  test("it analysed the tree", () => {
    expect(analysed).toBeGreaterThanOrEqual(15);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("domain-is-pure: the domain imports only itself (NFR-09)", () => {
  test("every way out is a violation", () => {
    expect(violating("domain-is-pure")).toEqual([
      "src/wagering/domain/leaks-application.ts",
      "src/wagering/domain/leaks-framework.ts",
      "src/wagering/domain/leaks-infrastructure.ts",
      "src/wagering/domain/leaks-node.ts",
      "src/wagering/domain/leaks-orm.ts",
    ]);
  });

  // Why the payload hash lives in application: not even node:crypto belongs in the domain.
  test("including the standard library", () => {
    expect(violations.some((v) => v.rule === "domain-is-pure" && v.from.endsWith("leaks-node.ts"))).toBe(
      true,
    );
  });

  test("a domain file that imports only the domain is clean", () => {
    expect(violations.filter((v) => v.from.endsWith("domain/clean.ts"))).toEqual([]);
  });
});

describe("application-stays-inside: use cases depend on the domain and their own ports (NFR-09)", () => {
  test("infrastructure, the ORM, the AWS SDK and platform are violations", () => {
    expect(violating("application-stays-inside")).toEqual([
      "src/wagering/application/leaks-aws.ts",
      "src/wagering/application/leaks-infrastructure.ts",
      "src/wagering/application/leaks-orm.ts",
      "src/wagering/application/leaks-platform.ts",
    ]);
  });

  test("the domain and the standard library are fine", () => {
    expect(violations.filter((v) => v.from.endsWith("application/fine.ts"))).toEqual([]);
  });
});

describe("platform-knows-no-business", () => {
  test("platform importing the wagering domain is a violation", () => {
    expect(violating("platform-knows-no-business")).toEqual(["src/platform/leaks-business.ts"]);
  });
});

describe("no-circular", () => {
  test("a cycle is a violation", () => {
    expect(violating("no-circular").length).toBeGreaterThan(0);
    expect(violating("no-circular").every((from) => from.includes("cycle-"))).toBe(true);
  });
});

describe("infrastructure is where frameworks belong", () => {
  // The control for everything above: if this reported a violation, the rules would be refusing too much.
  test("it may import the ORM, a framework, the domain and the application", () => {
    expect(violations.filter((v) => v.from.endsWith("infrastructure/ok.ts"))).toEqual([]);
  });
});

describe("nothing else is flagged", () => {
  test("every violation is one of the above", () => {
    const rules = new Set(violations.map((v) => v.rule));
    expect([...rules].sort()).toEqual([
      "application-stays-inside",
      "domain-is-pure",
      "no-circular",
      "platform-knows-no-business",
    ]);
  });
});
