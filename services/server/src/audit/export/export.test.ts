import { describe, expect, it, vi } from "vitest";
import { entry } from "../fixtures.js";
import { csvCell, csvHeader, csvRow, formatPage, jsonlRow } from "./format.js";
import { exportStream, type ExportOutcome } from "./stream.js";

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe("csv", () => {
  it("quotes separators, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("neutralizes spreadsheet formulas in text cells", () => {
    for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx"]) {
      expect(csvCell(cell).replace(/^"/, "")).toMatch(/^'/);
    }
    expect(csvCell(-5)).toBe("-5");
  });

  it("gives the install view the IP and chain columns and the team view neither", () => {
    expect(csvHeader("install").trim().split(",").slice(-4)).toEqual([
      "ip",
      "user_agent",
      "prev_hash",
      "hash",
    ]);
    expect(csvHeader("team")).not.toMatch(/hash|ip/);
    const row = csvRow(
      entry({ actor: { kind: "user", id: null, name: "=cmd", email: null } }),
      "install",
    );
    expect(row).toContain("'=cmd");
    expect(row).toContain("203.0.113.7");
    expect(row.endsWith("\r\n")).toBe(true);
  });

  it("writes the target as JSON in one cell", () => {
    const row = csvRow(entry(), "team");
    expect(row).toContain('"{""teamId"":""22222222-2222-4222-8222-222222222222""}"');
    expect(row).not.toContain("203.0.113.7");
  });
});

describe("jsonl", () => {
  it("is one object per line with ISO times", () => {
    const lines = formatPage([entry({ seq: 1 }), entry({ seq: 2 })], "jsonl", "install")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      seq: 2,
      at: "2026-10-01T12:00:00.123Z",
      ip: "203.0.113.7",
      hash: "b".repeat(64),
    });
  });

  it("leaves the IP, user agent and chain out of the team view", () => {
    const parsed = JSON.parse(jsonlRow(entry(), "team")) as Record<string, unknown>;
    for (const field of ["ip", "userAgent", "prevHash", "hash"])
      expect(parsed).not.toHaveProperty(field);
  });
});

describe("exportStream", () => {
  const first = { events: [entry({ seq: 1 }), entry({ seq: 2 })], nextCursor: 2 };
  const last = { events: [entry({ seq: 3 })], nextCursor: null };

  it("reads one page per pull, keyset after the last seq, and reports the outcome once", async () => {
    const fetchPage = vi.fn(async (after: number) => (after === 0 ? first : last));
    const outcomes: ExportOutcome[] = [];
    const text = await drain(
      exportStream({
        format: "csv",
        scope: "install",
        fetchPage,
        onDone: (o) => void outcomes.push(o),
      }),
    );
    expect(text.split("\r\n")).toHaveLength(5); // header, 3 rows, trailing empty
    expect(fetchPage.mock.calls.map(([a]) => a)).toEqual([0, 2]);
    expect(outcomes).toEqual([{ rows: 3, complete: true }]);
  });

  it("does not read ahead of the consumer (bounded memory)", async () => {
    const fetchPage = vi.fn(async () => first);
    const stream = exportStream({
      format: "jsonl",
      scope: "team",
      fetchPage,
      onDone: () => undefined,
    });
    const reader = stream.getReader();
    await reader.read();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it("records a cancelled download as incomplete", async () => {
    const outcomes: ExportOutcome[] = [];
    const stream = exportStream({
      format: "jsonl",
      scope: "team",
      fetchPage: async () => first,
      onDone: (o) => void outcomes.push(o),
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(outcomes).toEqual([{ rows: 2, complete: false }]);
  });

  it("errors the stream and reports incomplete when a page fails", async () => {
    const outcomes: ExportOutcome[] = [];
    const stream = exportStream({
      format: "jsonl",
      scope: "team",
      fetchPage: async () => {
        throw new Error("db down");
      },
      onDone: (o) => void outcomes.push(o),
    });
    await expect(drain(stream)).rejects.toThrow("db down");
    expect(outcomes).toEqual([{ rows: 0, complete: false }]);
  });
});
