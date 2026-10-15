import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-282 (ac-1): every popup that portals (Radix portals, assistant-ui menus that portal
 * internally, React portals) mounts inside the chat root, where the preflight slice (box-sizing,
 * border colour) applies, or into a slot of the shell. The tokens themselves are on `:root`
 * (app/theme.css), so colours resolve wherever a popup lands. A new portal fails here until it
 * names its container; the ledger (docs/ledger/KOBE-282.md) lists each popup and its theming.
 */
const WEB = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Opening tags that portal, and what each must carry. */
const PORTALS: [RegExp, RegExp][] = [
  // Radix portals (Dialog, Tooltip, Popover, DropdownMenu, …).
  [/<[A-Za-z]+\.Portal\b[^>]*>/g, /container=\{chatPortalContainer\(\)\}/],
  // assistant-ui's "more" menus (ActionBarMore, ThreadListItemMore) portal inside their Content.
  [
    /<[A-Za-z]+MorePrimitive\.Content\b[^>]*>/g,
    /portalProps=\{\{\s*container:\s*chatPortalContainer\(\)\s*\}\}/,
  ],
];

describe("popup portals (KOBE-282)", () => {
  const files = [...sources("components"), ...sources("app")];

  it.each(PORTALS.map(([tag, rule]) => [tag.source, tag, rule] as const))(
    "%s mounts in the chat root",
    (_name, tag, rule) => {
      const missing = files.flatMap((f) =>
        [...readFileSync(join(WEB, f), "utf8").matchAll(tag)]
          .filter(([open]) => !rule.test(open))
          .map(([open]) => `${f}: ${open.slice(0, 60)}`),
      );
      expect(missing).toEqual([]);
    },
  );

  it("React portals only fill the shell's own slots", () => {
    const users = files.filter((f) => readFileSync(join(WEB, f), "utf8").includes("createPortal("));
    expect(users).toEqual([join("components", "shell", "shell-slots.tsx")]);
  });
});
