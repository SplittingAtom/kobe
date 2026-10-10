import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Stand-ins for ripgrep and fd (neither is a dependency of the test machine): `rg` does a literal
 * substring search with ripgrep's `--json` output shape, `fd` prints what a `FAKE_FD_OUTPUT` file
 * lists. Both append their argument list to `FAKE_TOOL_LOG`, so a test can prove the routed tool
 * and Pi's own run the programs with identical arguments.
 */
const RG = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, "rg " + JSON.stringify(argv) + "\\n");
const sep = argv.indexOf("--");
const pattern = argv[sep + 1];
const target = argv[sep + 2];
const ignoreCase = argv.includes("--ignore-case");
const globIndex = argv.indexOf("--glob");
const glob = globIndex === -1 ? undefined : argv[globIndex + 1];
if (pattern === "FAIL") { process.stderr.write("rg: boom\\n"); process.exit(2); }
function files(p) {
  const info = fs.statSync(p);
  if (!info.isDirectory()) return [p];
  return fs.readdirSync(p).sort().flatMap((n) => files(path.join(p, n)));
}
let found = false;
for (const file of files(target)) {
  if (glob && !new RegExp("^" + glob.replace(/\\./g, "\\\\.").replace(/\\*/g, ".*") + "$").test(path.basename(file))) continue;
  const lines = fs.readFileSync(file, "utf8").split("\\n");
  lines.forEach((line, i) => {
    const hay = ignoreCase ? line.toLowerCase() : line;
    if (hay.includes(ignoreCase ? pattern.toLowerCase() : pattern)) {
      found = true;
      console.log(JSON.stringify({ type: "match", data: { path: { text: file }, line_number: i + 1, lines: { text: line + "\\n" } } }));
    }
  });
}
process.exit(found ? 0 : 1);
`;

const FD = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, "fd " + JSON.stringify(argv) + "\\n");
const out = process.env.FAKE_FD_OUTPUT;
if (out) process.stdout.write(fs.readFileSync(out, "utf8"));
process.exit(0);
`;

/** Writes executable `rg` and `fd` into a fresh `bin` directory under `root`; returns it. */
export async function writeFakeSearchTools(root: string): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, source] of [
    ["rg", RG],
    ["fd", FD],
  ] as const) {
    const file = path.join(bin, name);
    await writeFile(file, source);
    await chmod(file, 0o755);
  }
  return bin;
}
