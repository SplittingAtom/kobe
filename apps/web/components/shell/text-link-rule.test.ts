import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** KOBE-203 (CE13, ac-3): the repo's ESLint config refuses bare text links in the chat shell. */
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function textLinkErrors(jsx: string, file = "components/chat/fixture.tsx"): Promise<number> {
  const code = `import Link from "next/link";\nexport function X({ c }: { c: string }) {\n  return (\n    <>\n      ${jsx}\n    </>\n  );\n}\n`;
  const [result] = await eslint.lintText(code, { filePath: `${root}apps/web/${file}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax").length;
}

const TEXT_LINK = `<a href="/me/memory">My memory</a>`;

describe("no bare text links in the chat shell", () => {
  it("fails on a text link in components/chat and components/shell", async () => {
    expect(await textLinkErrors(TEXT_LINK)).toBe(1);
    expect(await textLinkErrors(TEXT_LINK, "components/shell/fixture.tsx")).toBe(1);
  });

  it.each([
    ["a next/link Link with text", `<Link href="/me/memory">My memory</Link>`],
    ["a string expression child", `<a href="/x">{"My memory"}</a>`],
    ["a template literal child", "<a href={c}>{`Version ${c}`}</a>"],
    ["text nested in a span", `<a href="/x"><span className="sr-only">My memory</span></a>`],
    ["a non-ASCII label", `<Link href="/x">Mémoire</Link>`],
    ["a label in another script", `<a href="/x">記憶</a>`],
  ])("fails on %s", async (_name, jsx) => {
    expect(await textLinkErrors(jsx)).toBe(1);
  });

  it("allows icon links, content passed as children, and attribute strings", async () => {
    const ok = [
      `<a href="/x" aria-label="My memory"><svg /></a>`,
      `<a href="/y">{c}</a>`,
      `<a href={"/z"} title={"My memory"} aria-hidden>[{c}]</a>`,
      `<Link href={"/me"}>{c}</Link>`,
    ].join("\n      ");
    expect(await textLinkErrors(ok)).toBe(0);
  });

  it("leaves other areas alone", async () => {
    expect(await textLinkErrors(TEXT_LINK, "components/admin/fixture.tsx")).toBe(0);
  });
});
