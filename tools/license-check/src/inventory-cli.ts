/**
 * Third-party inventory (KOBE-375): THIRD_PARTY_LICENSES.md and NOTICE at the repository root.
 *
 *   inventory-cli.js check                         fail if either file is stale or a component lacks an entry
 *   inventory-cli.js update                        rewrite both files
 *   inventory-cli.js image-report <id> <raw.json> [--check]
 *                                                  write (or compare) the committed image report
 *                                                  from collect-licenses.sh output
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory, type RepoFiles } from "./inventory/build.js";
import { canonicalImageReport, type ImageReport, type PackageFiles } from "./inventory/rows.js";
import { parseInventory } from "./inventory/source.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = "tools/license-check/inventory.yaml";
const OUTPUTS = ["THIRD_PARTY_LICENSES.md", "NOTICE"] as const;
const UPDATE_HINT = "Run `pnpm licenses:update` and commit the result.";

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const NOTICE_FILE = /^notice(?:\.(?:txt|md))?$/i;

const packageFiles: PackageFiles = {
  licenseFile: (dir) =>
    readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()[0],
  notice: (dir) => {
    const file = readdirSync(dir)
      .filter((f) => NOTICE_FILE.test(f))
      .sort()[0];
    return file ? readFileSync(join(dir, file), "utf8").trim() : undefined;
  },
};

function repoFiles(): RepoFiles {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(ROOT, f)));
  return {
    tracked,
    read,
    readJson: (path) => JSON.parse(read(path)) as unknown,
    pnpmReport: () =>
      JSON.parse(
        execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      ) as never,
    packageFiles,
  };
}

function fail(lines: readonly string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

function run(mode: "check" | "update"): void {
  const inventory = parseInventory(read(SOURCE));
  const built = buildInventory(inventory, repoFiles());
  const outputs: Record<(typeof OUTPUTS)[number], string> = {
    "THIRD_PARTY_LICENSES.md": built.markdown,
    NOTICE: built.notice,
  };
  const stale = OUTPUTS.filter((f) => !existsSync(join(ROOT, f)) || read(f) !== outputs[f]);
  if (mode === "update") {
    for (const f of stale) writeFileSync(join(ROOT, f), outputs[f]);
    console.log(stale.length > 0 ? `Updated ${stale.join(", ")}.` : "Inventory up to date.");
  }
  const problems = [
    ...built.problems,
    ...(mode === "check" ? stale.map((f) => `${f} is stale. ${UPDATE_HINT}`) : []),
  ];
  if (problems.length > 0) {
    fail([`Third-party inventory check failed (${SOURCE}):`, ...problems.map((p) => `  - ${p}`)]);
  }
  if (mode === "check") {
    console.log(`Third-party inventory up to date: ${built.rowCount} components.`);
  }
}

function imageReport(id: string | undefined, rawPath: string | undefined, check: boolean): void {
  const inventory = parseInventory(read(SOURCE));
  const source = inventory.imageReports.find((r) => r.id === id);
  if (!source || !rawPath) {
    fail([
      `usage: image-report <${inventory.imageReports.map((r) => r.id).join("|")}> <raw.json> [--check]`,
    ]);
  }
  const fresh = canonicalImageReport(JSON.parse(readFileSync(rawPath, "utf8")) as ImageReport);
  if (!check) {
    writeFileSync(join(ROOT, source.report), fresh);
    console.log(`Wrote ${source.report}. Now run \`pnpm licenses:update\`.`);
    return;
  }
  const committed = existsSync(join(ROOT, source.report))
    ? canonicalImageReport(JSON.parse(read(source.report)) as ImageReport)
    : "";
  if (committed !== fresh) {
    fail([
      `${source.report} does not match the packages in the built image.`,
      `Regenerate: images/sandbox/collect-licenses.sh <image> > raw.json && ` +
        `node tools/license-check/dist/inventory-cli.js image-report ${source.id} raw.json && ` +
        "pnpm licenses:update (CI uploads raw.json as an artifact when this fails).",
    ]);
  }
  console.log(`${source.report} matches the image.`);
}

const [command = "check", ...rest] = process.argv.slice(2);
try {
  if (command === "check" || command === "update") run(command);
  else if (command === "image-report") imageReport(rest[0], rest[1], rest.includes("--check"));
  else fail([`unknown command ${command}`]);
} catch (error) {
  fail([`Third-party inventory: ${error instanceof Error ? error.message : String(error)}`]);
}
