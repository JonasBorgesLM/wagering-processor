// Applies each mutant of mutants.ts to the source, runs the tests that guard it, restores the file, and fails if any
// mutant survives (issue #55).
//
//   bun run test:mutation                      # every mutant
//   bun run test:mutation wallet-lock inbox-record
//   bun run test:mutation --list
//
// Needs `docker compose up -d --wait postgres sqs`, like the suites it runs. It edits files in place and puts them
// back in a `finally` and on SIGINT/SIGTERM; it refuses to start when a file it will edit has uncommitted changes,
// because restoring those from here would be guessing which version was meant.
import { readFileSync, writeFileSync } from "node:fs";
import { MUTANTS, type Mutant } from "./mutants";

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.id.padEnd(32)} ${m.guards.padEnd(22)} ${m.protection}`);
  process.exit(0);
}
const selected = args.length === 0 ? MUTANTS : MUTANTS.filter((m) => args.includes(m.id));
const unknown = args.filter((a) => !MUTANTS.some((m) => m.id === a));
if (unknown.length > 0) {
  console.error(`No such mutant: ${unknown.join(", ")}. Try --list.`);
  process.exit(2);
}

async function run(command: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, output: out + err };
}

const bunTest = (m: Pick<Mutant, "tests" | "filter">) => [
  "bun",
  "test",
  "--timeout",
  "180000",
  ...m.tests,
  ...(m.filter ? ["-t", m.filter] : []),
];

// Files edited, and their pristine text, so a signal can put them back.
const originals = new Map<string, string>();
const restoreAll = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

for (const file of new Set(selected.map((m) => m.file))) {
  const dirty = await run(["git", "diff", "--quiet", "HEAD", "--", file]);
  if (dirty.code !== 0) {
    console.error(`${file} has uncommitted changes; commit or stash them first.`);
    process.exit(2);
  }
}

type Verdict = "killed" | "SURVIVED" | "STALE" | "ERRORED";
const results: Array<{ mutant: Mutant; verdict: Verdict; note: string }> = [];

// A test set that is red before the edit would "kill" every mutant and prove nothing.
const baselines = new Set<string>();
for (const m of selected) {
  const key = JSON.stringify([m.tests, m.filter]);
  if (baselines.has(key)) continue;
  baselines.add(key);
  process.stdout.write(`baseline  ${m.tests.join(" ")}${m.filter ? ` -t "${m.filter}"` : ""} ... `);
  const base = await run(bunTest(m));
  if (base.code !== 0) {
    console.log("RED\n");
    console.log(base.output.split("\n").slice(-30).join("\n"));
    console.error("\nThe tests fail before any mutation; fix them first.");
    process.exit(2);
  }
  console.log("green");
}

for (const m of selected) {
  process.stdout.write(`${m.id.padEnd(32)} `);
  const original = readFileSync(m.file, "utf8");
  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    results.push({
      mutant: m,
      verdict: "STALE",
      note: `the text to replace occurs ${occurrences} times, not once`,
    });
    console.log("STALE");
    continue;
  }
  originals.set(m.file, original);
  try {
    writeFileSync(
      m.file,
      original.replace(m.find, () => m.replace),
    );
    const outcome = await run(bunTest(m));
    if (outcome.code === 0) {
      results.push({ mutant: m, verdict: "SURVIVED", note: "the tests stayed green without the protection" });
    } else if (/^\(fail\)/m.test(outcome.output)) {
      const failed = [...outcome.output.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)].map((x) => x[1]);
      results.push({
        mutant: m,
        verdict: "killed",
        note: `${failed.length} test(s) failed: ${failed[0] ?? ""}`,
      });
    } else {
      results.push({
        mutant: m,
        verdict: "ERRORED",
        note: `the run failed without a failed assertion (a build error does not count):\n${outcome.output.split("\n").slice(-8).join("\n")}`,
      });
    }
  } finally {
    writeFileSync(m.file, original);
    originals.delete(m.file);
  }
  console.log(results.at(-1)?.verdict);
}

console.log("\n=== mutation testing");
for (const { mutant, verdict, note } of results) {
  console.log(`${verdict.padEnd(9)} ${mutant.id.padEnd(32)} ${mutant.guards.padEnd(22)} ${note}`);
}
const bad = results.filter((r) => r.verdict !== "killed");
console.log(`\n${results.length - bad.length} of ${results.length} mutants killed.`);
if (bad.length > 0) {
  console.error(
    `${bad.length} did not die: a protection no test would miss, or a mutant that no longer applies.`,
  );
  process.exit(1);
}
