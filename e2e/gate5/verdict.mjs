// Gate 5 (KOBE-227): Playwright's JSON report (e2e/browser, `test-results/results.json`) as the
// harness's check lines, for one story's spec files. Run by e2e/gate5.sh:
//   node e2e/gate5/verdict.mjs <results.json> <spec file>...
// One line per test: `ok   <file>: <title>`, `FAIL ...: <first error line>`, `XFAIL` (a test.fail()
// for a filed product failure that still fails), `XPASS` (it passes now: drop the marker),
// `NOTRUN` (skipped, with the reason: the story is not proven here). A spec file with no tests in
// the report (it did not load) is a FAIL.
import { readFileSync } from "node:fs";

const [resultsPath, ...files] = process.argv.slice(2);
let report;
try {
  report = JSON.parse(readFileSync(resultsPath, "utf8"));
} catch (err) {
  console.log(`FAIL browser report ${resultsPath}: ${err instanceof Error ? err.message : err}`);
  process.exit(0);
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const oneLine = (s) =>
  String(s ?? "")
    // Playwright colours its messages.
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ")
    .slice(0, 300);

/** Every test of the report with its spec file and full title. */
function* tests(suite, file, path) {
  const here = suite.file ?? file;
  const titles = suite.title && suite.title !== here ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.projectName === "setup") continue;
      yield { file: spec.file ?? here, title: [...titles, spec.title].join(" › "), test: t };
    }
  }
  for (const child of suite.suites ?? []) yield* tests(child, here, titles);
}

const all = [...(report.suites ?? []).flatMap((s) => [...tests(s, s.file, [])])];
for (const file of files) {
  const mine = all.filter((x) => x.file === file || x.file?.endsWith(`/${file}`));
  if (mine.length === 0) {
    console.log(`FAIL ${file}: no test of it ran (it failed to load, or was not selected)`);
    continue;
  }
  for (const { title, test } of mine) {
    const last = test.results?.at(-1);
    const label = `${file}: ${title}`;
    if (test.status === "skipped") {
      const why = test.annotations?.find((a) => a.type === "skip")?.description ?? "skipped";
      console.log(`NOTRUN ${label}: ${why}`);
    } else if (test.expectedStatus === "failed") {
      const why = test.annotations?.find((a) => a.type === "fail")?.description ?? "";
      if (test.status === "expected")
        console.log(`XFAIL ${label}: ${oneLine(last?.error?.message)} (${why})`);
      else console.log(`XPASS ${label}: passes now, remove its test.fail marker (${why})`);
    } else if (test.status === "expected" || test.status === "flaky") {
      console.log(`ok   ${label}`);
    } else {
      console.log(`FAIL ${label}: ${last?.status ?? "?"}: ${oneLine(last?.error?.message)}`);
    }
  }
}
