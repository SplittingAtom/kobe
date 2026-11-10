// Diffs what each case sent to Bifrost against what Bifrost forwarded upstream.
// Usage: node compare.mjs results-a.json [results-b.json]  (prints one block per case)
// Paths are JSON paths; "-" removed, "+" added, "~" changed. A raw (duplicate-key) body is
// compared against JSON.parse of it, which keeps the last duplicate.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function diff(a, b, path = "", out = []) {
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push(`- ${path}.${k} = ${JSON.stringify(a[k])}`);
      else diff(a[k], b[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(b))
      if (!(k in a)) out.push(`+ ${path}.${k} = ${JSON.stringify(b[k])}`);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out));
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`~ ${path} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return out;
}
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

for (let i = 0; i < runs[0].length; i++) {
  console.log(`## ${runs[0][i].id}`);
  runs.forEach((run, r) => {
    const c = run[i];
    const label = files[r].replace(/^.*results-|\.json$/g, "");
    if (c.refusedByGateway) {
      console.log(`  [${label}] refused by the gateway: ${c.refusedByGateway}`);
      return;
    }
    if (c.upstream.length === 0) {
      console.log(`  [${label}] status ${c.status}, nothing forwarded: ${c.reply}`);
      return;
    }
    for (const u of c.upstream) {
      const d = diff(parse(c.sent), parse(u.body));
      console.log(
        `  [${label}] status ${c.status} -> upstream ${u.path} ${JSON.stringify(u.headers)}`,
      );
      for (const line of d) console.log(`    ${line}`);
      if (d.length === 0) console.log("    (identical)");
    }
  });
}
