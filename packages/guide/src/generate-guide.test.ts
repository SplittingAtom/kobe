// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** KOBE-616 (ac-5): the generator writes the typed module, or fails the build with the reasons. */
const SCRIPT = fileURLToPath(new URL("../scripts/generate-guide.mjs", import.meta.url));
let dir = "";

function run(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "kobe-guide-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "guide", path)), { recursive: true });
    writeFileSync(join(dir, "guide", path), content);
  }
  const out = join(dir, "pages.ts");
  const r = spawnSync(process.execPath, [SCRIPT, join(dir, "guide"), out], { encoding: "utf8" });
  return { ...r, out };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const PAGE = "---\ntitle: A\nsummary: S.\nsection: Memory\n---\nSee [b](sub/b.md).\n";
const B = "---\ntitle: B\nsummary: S.\nsection: Memory\n---\nB.\n";

describe("scripts/generate-guide.mjs", () => {
  it("writes the pages as a typed module", () => {
    const r = run({ "a.md": PAGE, "sub/b.md": B });
    expect(r.status, r.stderr).toBe(0);
    const source = readFileSync(r.out, "utf8");
    expect(source).toContain('import type { GuidePage } from "../loader.js";');
    expect(source).toContain("export const GUIDE_PAGES: readonly GuidePage[] = [");
    expect(source).toContain('"slug": "sub/b"');
    expect(source).toContain("(/docs/sub/b)");
  });

  it("exits 1 and lists every problem", () => {
    const r = run({
      "a.md": PAGE.replace("section: Memory", "section: Nope"),
      "c.md": "---\nsummary: S.\nsection: Memory\n---\n[x](gone.md)\n",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/guide/a.md: unknown section "Nope"');
    expect(r.stderr).toContain("docs/guide/c.md: title is required");
  });
});
