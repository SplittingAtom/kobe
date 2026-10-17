import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * KOBE-282 (ac-1): every popup that portals (Radix portals, assistant-ui menus that portal
 * internally, React portals) mounts inside the chat root (a console's dialog in the console root,
 * KOBE-294), where the preflight slice (box-sizing,
 * border colour) applies, or into a slot of the shell. The tokens themselves are on `:root`
 * (app/theme.css), so colours resolve wherever a popup lands. A new portal fails here until it
 * names its container; the ledger (docs/ledger/KOBE-282.md) lists each popup and its theming.
 * The sources are parsed (TypeScript's TSX parser), so props holding arrow functions or JSX don't
 * cut a tag short.
 */
const WEB = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Tags that portal, the prop that must name the chat root, and how its value must read. */
const PORTALS = [
  // Radix portals (Dialog, Tooltip, Popover, DropdownMenu, …); the consoles' own dialogs mount in
  // the console root (KOBE-294).
  { tag: /\.Portal$/, prop: "container", value: /^\{(chat|console)PortalContainer\(\)\}$/ },
  // assistant-ui's "more" menus (ActionBarMore, ThreadListItemMore) portal inside their Content.
  {
    tag: /MorePrimitive\.Content$/,
    prop: "portalProps",
    value: /^\{\{\s*container:\s*chatPortalContainer\(\)\s*\}\}$/,
  },
] as const;

/** `file: <Tag>` for each portalling element of `code` that does not name the chat root. */
function unrooted(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const rule = PORTALS.find((p) => p.tag.test(tag));
      const prop = node.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(source) === rule?.prop,
      );
      if (rule && !rule.value.test(prop?.initializer?.getText(source) ?? "")) {
        out.push(`${file}: <${tag}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("popup portals (KOBE-282)", () => {
  const files = [...sources("components"), ...sources("app")];

  it("every Radix portal and assistant-ui menu mounts in the chat root", () => {
    expect(files.flatMap((f) => unrooted(f, readFileSync(join(WEB, f), "utf8")))).toEqual([]);
  });

  it("reads whole tags, arrow-function props included", () => {
    const tag = (props: string) =>
      unrooted("x.tsx", `const x = <Dialog.Portal ${props}><div /></Dialog.Portal>;`);
    expect(tag("onMount={() => 1 > 0} container={chatPortalContainer()}")).toEqual([]);
    expect(tag("onMount={() => 1 > 0}")).toEqual(["x.tsx: <Dialog.Portal>"]);
    expect(
      unrooted("y.tsx", "const y = <M.ActionBarMorePrimitive.Content onSelect={(e) => e} />;"),
    ).toEqual(["y.tsx: <M.ActionBarMorePrimitive.Content>"]);
  });

  it("React portals only fill the shell's own slots", () => {
    const users = files.filter((f) => readFileSync(join(WEB, f), "utf8").includes("createPortal("));
    expect(users).toEqual([join("components", "shell", "shell-slots.tsx")]);
  });
});
