import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Non-negotiable (CLAUDE.md, D11, D13): sandboxes accept no inbound connections. The agent's
 * production code must never create a listening socket; only the test fake server listens.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const LISTENERS = [
  /\bcreateServer\s*\(/,
  /\.listen\s*\(/,
  /\bWebSocketServer\b/,
  /\bnode:http2?\b/,
  /\bnode:https\b/,
  /\bnode:dgram\b/,
  /\bcreateSocket\s*\(/,
];
const SECRET_CHANNELS = [/process\.env\.[A-Z_]*(TOKEN|SECRET|API_KEY)/];

async function productionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "testing" ? [] : productionFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    }),
  );
  return files.flat();
}

describe("sandbox-agent production code", () => {
  it("never opens a listening socket", async () => {
    const files = await productionFiles(SRC);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of LISTENERS) {
        expect({ file: path.relative(SRC, file), match: pattern.test(text) }).toEqual({
          file: path.relative(SRC, file),
          match: false,
        });
      }
    }
  });

  it("reads no token or key from its environment (the wire token comes from a file)", async () => {
    for (const file of await productionFiles(SRC)) {
      const text = await readFile(file, "utf8");
      for (const pattern of SECRET_CHANNELS) expect(pattern.test(text)).toBe(false);
    }
  });
});
