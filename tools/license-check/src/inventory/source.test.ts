import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderInventory, renderNotice } from "./render.js";
import { parseInventory, unapprovedRows } from "./source.js";

const BASE = `
notice: Kobe
npm:
  title: npm
  intro: i
  exceptions: e.json
  deployables: { apps/web: web }
  platformPackages: []
imageReports: []
chartValues:
  global: first-party
  s3: site-provided
  bifrost: [bifrost]
`;

const section = (row: string) => `${BASE}
sections:
  - id: chart
    title: Chart
    intro: i
    rows:
      - id: bifrost
        component: Bifrost
        version: v2.2.5
        use: separate process
        where: cluster
        link: https://example.org/LICENSE
        images: [maximhq/bifrost]
${row}`;

describe("parseInventory", () => {
  it("parses the committed inventory", () => {
    const text = readFileSync(new URL("../../inventory.yaml", import.meta.url), "utf8");
    const inventory = parseInventory(text);
    expect(inventory.sections.map((s) => s.id)).toEqual(["images", "chart", "dev", "assets"]);
    expect(inventory.sections.flatMap((s) => s.rows.map((r) => r.id))).toEqual(
      expect.arrayContaining(["pi", "agent-sandbox", "gvisor", "kata", "cnpg", "postgres"]),
    );
  });

  it("accepts an allowed license without an approval", () => {
    const inventory = parseInventory(section("        license: Apache-2.0"));
    expect(unapprovedRows(inventory)).toEqual([]);
  });

  it("requires a reason and an approval outside the allowed family", () => {
    const pending = parseInventory(
      section("        license: GPL-2.0-only\n        reason: separate"),
    );
    expect(unapprovedRows(pending)).toEqual([
      expect.stringContaining("chart/bifrost: GPL-2.0-only is outside the allowed family"),
    ]);
    const approved = parseInventory(
      section(
        "        license: GPL-2.0-only\n        reason: separate\n" +
          "        approval: { by: Chris, on: 2026-10-17, ref: KOBE-375 }",
      ),
    );
    expect(unapprovedRows(approved)).toEqual([]);
  });

  it("rejects a malformed approval date, an unknown row id and a missing field", () => {
    expect(() =>
      parseInventory(
        section("        license: MIT\n        approval: { by: Chris, on: 17.10.2026 }"),
      ),
    ).toThrow(/approval.on: must be YYYY-MM-DD/);
    expect(() =>
      parseInventory(section("        license: MIT").replace("[bifrost]", "[nope]")),
    ).toThrow(/chartValues.bifrost/);
    expect(() => parseInventory(section(""))).toThrow(/rows\[0\].license/);
  });
});

describe("render", () => {
  it("escapes table cells and lists hand rows with their notes", () => {
    const inventory = parseInventory(
      section(
        "        license: GPL-2.0-only\n        reason: a | b\n" +
          "        approval: { by: Chris, on: 2026-10-17, ref: KOBE-375 }",
      ),
    );
    const md = renderInventory({
      generated: [
        {
          title: "npm",
          intro: "i",
          rows: [
            {
              component: "x",
              version: "1",
              license: "MIT",
              use: "dev-only",
              where: "w",
              link: "https://l",
            },
          ],
        },
      ],
      sections: inventory.sections,
      appended: {},
    });
    expect(md).toContain("| x | 1 | MIT | dev-only | w | [license](https://l) |");
    expect(md).toContain("1 packages, 0 of them shipped in an image.");
    expect(md).toContain("a \\| b Approved by Chris on 2026-10-17 (KOBE-375). |");
  });

  it("puts each bundled NOTICE after Kobe's own", () => {
    const notice = renderNotice("Kobe\nCopyright", [
      { component: "pyarrow", version: "25", where: "sandbox image", text: "Apache Arrow\n" },
    ]);
    expect(notice.startsWith("Kobe\nCopyright\n")).toBe(true);
    expect(notice).toMatch(/pyarrow 25 \(sandbox image\)\n-+\n\nApache Arrow\n$/);
  });
});
