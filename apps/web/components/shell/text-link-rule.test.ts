import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** KOBE-203 (CE13, ac-3): the repo's ESLint config refuses bare text links in the chat shell. */
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function textLinkErrors(code: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: `${root}apps/web/${file}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax").length;
}

const TEXT_LINK = `export function X() {\n  return <a href="/me/memory">My memory</a>;\n}\n`;

describe("no bare text links in the chat shell", () => {
  it("fails on a text link in components/chat and components/shell", async () => {
    expect(await textLinkErrors(TEXT_LINK, "components/chat/fixture.tsx")).toBe(1);
    expect(await textLinkErrors(TEXT_LINK, "components/shell/fixture.tsx")).toBe(1);
  });

  it("allows an icon link with an accessible label, and content rendered through children", async () => {
    const icon = `export function X({ c }: { c: string }) {\n  return (\n    <>\n      <a href="/x" aria-label="My memory"><svg /></a>\n      <a href="/y">{c}</a>\n    </>\n  );\n}\n`;
    expect(await textLinkErrors(icon, "components/chat/fixture.tsx")).toBe(0);
  });

  it("leaves other areas alone", async () => {
    expect(await textLinkErrors(TEXT_LINK, "components/admin/fixture.tsx")).toBe(0);
  });
});
