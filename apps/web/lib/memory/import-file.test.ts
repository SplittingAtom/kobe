import { describe, expect, it } from "vitest";
import {
  IMPORT_UI_MAX_ROWS,
  bulletItem,
  guessFormat,
  markdownToJson,
  readImport,
} from "./import-file";
import { rowClass, type ImportRow } from "./transfer-api";

/** KOBE-385 (ac-2): reading Markdown, CSV and JSON imports in the browser, and naming rows. */
describe("Markdown bullets", () => {
  it("reads `- [kind] statement #tag` with tags only at the end", () => {
    expect(bulletItem("[Fact] Invoices go out on the 1st #billing #Ops")).toEqual({
      kind: "fact",
      statement: "Invoices go out on the 1st",
      tags: ["billing", "ops"],
    });
    expect(bulletItem("Issue #12 is the #1 priority")).toEqual({
      statement: "Issue #12 is the #1 priority",
      tags: [],
    });
  });

  it("turns bullets into a Kobe export and skips other lines", () => {
    const { content, rows } = markdownToJson(
      "# Team facts\n\n- [fact] One #a\n* [convention] Two\nnot a bullet\n-   \n",
    );
    expect(rows).toBe(2);
    expect(JSON.parse(content)).toEqual({
      format: "kobe.memory.v1",
      items: [
        { kind: "fact", statement: "One", tags: ["a"] },
        { kind: "convention", statement: "Two", tags: [] },
      ],
    });
  });
});

describe("readImport", () => {
  it("sends Markdown as JSON, CSV and JSON as they are, with the row count", () => {
    expect(readImport("markdown", "- [fact] One")).toMatchObject({
      ok: true,
      file: { format: "json", rows: 1 },
    });
    const csv = 'statement,kind,tags,pinned\nOne,fact,a;b,true\n"Two, quoted",fact,,\n';
    expect(readImport("csv", csv)).toEqual({
      ok: true,
      file: { format: "csv", content: csv, rows: 2 },
    });
    const json = JSON.stringify({
      format: "kobe.memory.v1",
      items: [{ kind: "fact", statement: "x" }],
    });
    expect(readImport("json", json)).toEqual({
      ok: true,
      file: { format: "json", content: json, rows: 1 },
    });
  });

  it(`refuses more than ${IMPORT_UI_MAX_ROWS} rows, and empty or unreadable input`, () => {
    const many = Array.from({ length: IMPORT_UI_MAX_ROWS + 1 }, (_, i) => `- [fact] Row ${i}`).join(
      "\n",
    );
    expect(readImport("markdown", many)).toMatchObject({
      ok: false,
      message: expect.stringContaining("201 rows"),
    });
    const csv = `statement,kind\n${"a,fact\n".repeat(IMPORT_UI_MAX_ROWS)}`;
    expect(readImport("csv", csv).ok).toBe(true);
    expect(readImport("csv", `${csv}b,fact\n`).ok).toBe(false);
    expect(readImport("markdown", "  ").ok).toBe(false);
    expect(readImport("markdown", "no bullets").ok).toBe(false);
    expect(readImport("json", "{").ok).toBe(false);
  });

  it("guesses the format from the file name, else the text", () => {
    expect(guessFormat("facts.CSV", "")).toBe("csv");
    expect(guessFormat("export.json", "")).toBe("json");
    expect(guessFormat("notes.md", "")).toBe("markdown");
    expect(guessFormat(null, '{"format":"kobe.memory.v1"}')).toBe("json");
    expect(guessFormat(null, "statement,kind\nx,fact")).toBe("csv");
    expect(guessFormat(null, "- [fact] x")).toBe("markdown");
  });
});

describe("rowClass", () => {
  const row = (status: ImportRow["status"], codes: string[] = []): ImportRow => ({
    index: 0,
    status,
    kind: "fact",
    statement: "x",
    tags: [],
    pinned: false,
    policy: false,
    issues: codes.map((code) => ({ code, message: code })),
  });

  it("names the six preview classes and unreadable rows", () => {
    expect(rowClass(row("new"))).toBe("new");
    expect(rowClass(row("duplicate", ["near_duplicate"]))).toBe("near-duplicate");
    expect(rowClass(row("warning", ["policy_conflict"]))).toBe("conflict");
    expect(rowClass(row("warning", ["instruction_imperative", "policy_conflict"]))).toBe(
      "conflict",
    );
    expect(rowClass(row("warning", ["personal_email"]))).toBe("lint-flagged");
    expect(rowClass(row("blocked", ["secret"]))).toBe("secret");
    expect(rowClass(row("invalid", ["policy_not_allowed"]))).toBe("policy-blocked");
    expect(rowClass(row("invalid", ["policy_budget"]))).toBe("policy-blocked");
    expect(rowClass(row("invalid", ["invalid_row"]))).toBe("unreadable");
  });
});
