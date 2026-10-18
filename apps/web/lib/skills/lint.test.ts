import { describe, expect, it } from "vitest";
import { lintSkill, type LintItem } from "./lint";
import { descriptionMeter } from "./meter";

const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}`;
const GOOD = md(
  "name: report-writer\ndescription: Writes monthly finance reports. Use when asked for a report.",
  "# Report\nRun `scripts/build.py`. See [the guide](references/guide.md).\n",
);
const PATHS = ["SKILL.md", "scripts/build.py", "references/guide.md", "evals/cases.yaml"];

const ids = (items: readonly LintItem[]) => items.map((i) => i.id);

/** SK12 lint (KOBE-321): name rules, what and when, referenced files, scripts, paths, evals. */
describe("lintSkill", () => {
  it("finds nothing in a good skill", () => {
    expect(lintSkill({ skillMd: GOOD, paths: PATHS })).toEqual([]);
  });

  it("refuses SKILL.md without frontmatter and still checks the files", () => {
    const items = lintSkill({ skillMd: "# no frontmatter", paths: ["SKILL.md"] });
    expect(ids(items)).toEqual(["frontmatter", "evals"]);
    expect(items[0]?.level).toBe("error");
  });

  it("checks the name rules", () => {
    for (const name of ["Report", "report_writer", "-report", "a".repeat(65), ""]) {
      const items = lintSkill({ skillMd: GOOD.replace("report-writer", name), paths: PATHS });
      expect(ids(items), name).toEqual(["name"]);
      expect(items[0]?.level).toBe("error");
    }
    const doubled = lintSkill({
      skillMd: GOOD.replace("report-writer", "report--writer"),
      paths: PATHS,
    });
    expect(doubled).toEqual([expect.objectContaining({ id: "name-hyphens", level: "warning" })]);
  });

  it("asks the description to say what the skill does and when to use it", () => {
    const what = GOOD.replace(
      "Writes monthly finance reports. Use when asked for a report.",
      "Use when asked.",
    );
    expect(ids(lintSkill({ skillMd: what, paths: PATHS }))).toEqual(["description-what"]);
    const when = GOOD.replace(
      "Writes monthly finance reports. Use when asked for a report.",
      "Writes monthly finance reports with charts and tables.",
    );
    expect(ids(lintSkill({ skillMd: when, paths: PATHS }))).toEqual(["description-when"]);
    const none = GOOD.replace(
      "description: Writes monthly finance reports. Use when asked for a report.",
      "description: ''",
    );
    expect(lintSkill({ skillMd: none, paths: PATHS })).toEqual([
      expect.objectContaining({ id: "description", level: "error" }),
    ]);
  });

  it("names referenced files that are not in the draft", () => {
    const items = lintSkill({
      skillMd: GOOD,
      paths: ["SKILL.md", "scripts/build.py", "evals/x.yaml"],
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: "missing-file",
        level: "warning",
        file: "references/guide.md",
      }),
    ]);
    // Web links, anchors and folders that hold files are fine.
    const links = md(
      "name: a\ndescription: Does a. Use when asked.",
      "[x](https://x.test/y.md) [y](#top) [z](mailto:a@b.c) [refs](references/) `scripts/build.py`",
    );
    expect(lintSkill({ skillMd: links, paths: PATHS })).toEqual([]);
    const dotted = md(
      "name: a\ndescription: Does a. Use when asked.",
      "See [g](./references/guide.md#part) and `scripts/build.py`.",
    );
    expect(lintSkill({ skillMd: dotted, paths: PATHS })).toEqual([]);
  });

  it("asks SKILL.md to list every script, from scripts/ and from the scan", () => {
    const items = lintSkill({
      skillMd: GOOD,
      paths: [...PATHS, "scripts/clean.sh", "tools/fix.py"],
      scripts: ["scripts/build.py", "scripts/clean.sh", "tools/fix.py"],
    });
    expect(items).toEqual([
      expect.objectContaining({ id: "unlisted-script", file: "scripts/clean.sh" }),
      expect.objectContaining({ id: "unlisted-script", file: "tools/fix.py" }),
    ]);
  });

  it("flags absolute paths into the package, not other absolute paths", () => {
    const body = [
      "Run `/home/ada/skills/report-writer/scripts/build.py`.",
      "Or [this](/scripts/build.py), or C:\\skills\\report-writer\\references\\guide.md.",
      "Read /workspace/skills/report-writer/SKILL.md first.",
      "Write the output to /workspace/out/report.pdf; notes go in ~/notes/x.md.",
      "See https://x.test/scripts/build.py, then run `scripts/build.py` and see [g](references/guide.md).",
    ].join("\n");
    const items = lintSkill({
      skillMd: md("name: report-writer\ndescription: Writes reports. Use when asked.", body),
      paths: PATHS,
    });
    expect(items.filter((i) => i.id === "absolute-path").map((i) => i.message)).toEqual([
      expect.stringContaining("/home/ada/skills/report-writer/scripts/build.py"),
      expect.stringContaining("/scripts/build.py is"),
      expect.stringContaining("C:\\skills\\report-writer\\references\\guide.md"),
      expect.stringContaining("/workspace/skills/report-writer/SKILL.md"),
    ]);
  });

  it("asks for evals/", () => {
    expect(
      lintSkill({ skillMd: GOOD, paths: PATHS.filter((p) => !p.startsWith("evals/")) }),
    ).toEqual([expect.objectContaining({ id: "evals", level: "warning" })]);
  });
});

describe("descriptionMeter (SK12)", () => {
  it("is quiet up to 1,024 characters", () => {
    expect(descriptionMeter("x".repeat(1024))).toEqual({
      length: 1024,
      level: "ok",
      message: null,
    });
  });

  it("warns past 1,024 (the Agent Skills limit) and again past 1,536 (Claude Code's cap)", () => {
    const spec = descriptionMeter("x".repeat(1025));
    expect(spec.level).toBe("over_spec");
    expect(spec.message).toMatch(/1,024/);
    expect(descriptionMeter("x".repeat(1536)).level).toBe("over_spec");
    const portable = descriptionMeter("x".repeat(1537));
    expect(portable.level).toBe("over_portable");
    expect(portable.message).toMatch(/1,536/);
  });

  it("counts characters as the server does (UTF-16 code units)", () => {
    expect(descriptionMeter("😀").length).toBe(2);
  });
});
