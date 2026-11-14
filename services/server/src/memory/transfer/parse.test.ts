import { describe, expect, it } from "vitest";
import { MemoryItemError } from "../items/errors.js";
import { csvRecords, parseImport } from "./parse.js";

/** KOBE-385: reading import files (contract KOBE-377 transfer.ts). */
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof MemoryItemError ? err.code : String(err);
  }
  return "no error";
};

describe("CSV import", () => {
  it("reads the four-column CSV the consoles offer (statement, kind, tags, pinned)", () => {
    const rows = parseImport(
      "csv",
      'statement,kind,tags,pinned\r\n"Invoices go out on the 1st, always",fact,billing;Ops,true\nWe deploy on Tuesdays,convention,,\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      index: 0,
      statement: "Invoices go out on the 1st, always",
      kind: "fact",
      tags: ["billing", "ops"],
      pinned: true,
      status: "active",
      error: null,
    });
    expect(rows[1]).toMatchObject({ kind: "convention", tags: [], pinned: false, error: null });
  });

  it("reads the full export columns and undoes formula neutralising", () => {
    const rows = parseImport(
      "csv",
      "ref,kind,statement,tags,pinned,as_of,policy,status,superseded_by\r\nr1,fact,'=SUM(A1) is how we total,,false,2026-10-01,false,active,\r\n",
    );
    expect(rows[0]).toMatchObject({
      ref: "r1",
      statement: "=SUM(A1) is how we total",
      asOf: "2026-10-01",
      error: null,
    });
  });

  it("keeps a bad row as invalid with what could be read", () => {
    const rows = parseImport("csv", "statement,kind\nok,fact\nno kind here,\n,fact\nx,colour\n");
    expect(rows.map((r) => r.error)).toEqual([
      null,
      "The kind is missing.",
      "The statement is empty.",
      "The kind must be preference, fact, convention, definition or decision.",
    ]);
    expect(rows[1]?.statement).toBe("no kind here");
  });

  it("refuses an unreadable file whole", () => {
    expect(codeOf(() => parseImport("csv", "kind,colour\nfact,red\n"))).toBe(
      "memory_import_invalid",
    );
    expect(codeOf(() => parseImport("csv", "kind\nfact\n"))).toBe("memory_import_invalid");
    expect(codeOf(() => parseImport("csv", 'statement\n"never closed\n'))).toBe(
      "memory_import_invalid",
    );
  });

  it("refuses more rows than a scope holds", () => {
    const body = `statement,kind\n${"a,fact\n".repeat(1001)}`;
    expect(codeOf(() => parseImport("csv", body))).toBe("memory_import_too_large");
  });

  it("splits RFC 4180 records with quotes and line breaks", () => {
    expect(csvRecords('a,b\r\n"x, y","say ""hi"""\n"l1\nl2",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["l1\nl2", "z"],
    ]);
  });
});

describe("JSON import", () => {
  it("reads an export document and fills left-out fields", () => {
    const rows = parseImport(
      "json",
      JSON.stringify({
        format: "kobe.memory.v1",
        items: [
          { kind: "decision", statement: "We chose Postgres", tags: ["DB"] },
          { kind: "fact", statement: "Old", status: "superseded", ref: "a", superseded_by: "b" },
          "nonsense",
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ kind: "decision", tags: ["db"], pinned: false, error: null });
    expect(rows[1]).toMatchObject({ status: "superseded", ref: "a", supersededBy: "b" });
    expect(rows[2]?.error).toBe("The statement is empty.");
  });

  it("reads a file with a byte order mark and counts rows before reading them", () => {
    const doc = JSON.stringify({
      format: "kobe.memory.v1",
      items: [{ kind: "fact", statement: "x" }],
    });
    expect(parseImport("json", `\uFEFF${doc}`)).toHaveLength(1);
    const many = JSON.stringify({
      format: "kobe.memory.v1",
      items: Array.from({ length: 1001 }, () => 0),
    });
    expect(codeOf(() => parseImport("json", many))).toBe("memory_import_too_large");
  });

  it("refuses a file that is not a Kobe memory export", () => {
    expect(codeOf(() => parseImport("json", "{"))).toBe("memory_import_invalid");
    expect(codeOf(() => parseImport("json", '{"items":[]}'))).toBe("memory_import_invalid");
  });
});
