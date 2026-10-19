import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-303 ac-4: secrets never enter sandboxes. The code that renders a sandbox (its template,
 * env and pod: `sandbox/manifests.ts`, `sandbox/eval-manifests.ts`, `sandbox/provider.ts`) must not
 * reach, through any chain of relative imports, a module that can open a connector credential (a
 * member's grant or the site-wide key). Members' and site keys reach the upstream only through the
 * MCP proxy's internal grant endpoint.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENERS = ["connectors/site-key.ts", "connectors/grants.ts"];
const ROOTS = ["sandbox/manifests.ts", "sandbox/eval-manifests.ts", "sandbox/provider.ts"];

function reachable(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(SRC, root)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) {
      queue.push(resolve(dirname(file), `${m[1]}.ts`));
    }
  }
  return seen;
}

describe("sandbox rendering never reaches a connector credential (KOBE-303)", () => {
  it.each(ROOTS)("%s imports no credential opener", (root) => {
    const files = [...reachable(root)].map((f) => f.slice(SRC.length + 1));
    expect(files.length).toBeGreaterThan(0);
    for (const opener of OPENERS) expect(files).not.toContain(opener);
  });
});
