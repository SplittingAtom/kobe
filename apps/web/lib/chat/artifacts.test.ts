import { describe, expect, it } from "vitest";
import {
  artifactContentUrl,
  artifactFrameUrl,
  artifactIdFromToolResult,
  fenced,
  isFrameKind,
  parseCsv,
} from "./artifacts";

const ID = "00000000-0000-4000-8000-000700000001";

describe("artifact URLs", () => {
  it("puts the team in the query of the download and frame URLs (links can't send X-Kobe-Team)", () => {
    expect(artifactContentUrl(ID, 2, "t 1")).toBe(
      `/v1/artifacts/${ID}/versions/2/content?team=t%201`,
    );
    expect(artifactFrameUrl(ID, 1, "t1")).toBe(`/v1/artifacts/${ID}/versions/1/frame?team=t1`);
  });

  it("frames html and svg only", () => {
    expect(["html", "svg"].every((k) => isFrameKind(k as "html"))).toBe(true);
    expect(["markdown", "code", "csv", "mermaid"].some((k) => isFrameKind(k as "csv"))).toBe(false);
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"l1\nl2",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["l1\nl2", "z"],
    ]);
  });

  it("returns no rows for empty text and keeps empty fields", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backtick run in the content", () => {
    expect(fenced("x", "python")).toBe("```python\nx\n```");
    expect(fenced("a ```` b", null)).toBe("`````\na ```` b\n`````");
  });
});

describe("artifactIdFromToolResult", () => {
  it("reads the id from a JSON result and ignores anything else", () => {
    expect(artifactIdFromToolResult(JSON.stringify({ artifact_id: ID, version: 1 }))).toBe(ID);
    expect(artifactIdFromToolResult({ artifact_id: ID })).toBe(ID);
    expect(artifactIdFromToolResult({ artifact_id: "../x" })).toBeUndefined();
    expect(artifactIdFromToolResult("not json")).toBeUndefined();
    expect(artifactIdFromToolResult(undefined)).toBeUndefined();
  });
});
