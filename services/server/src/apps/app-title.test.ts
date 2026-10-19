import { describe, expect, it } from "vitest";
import type { PinnedTool } from "@kobe/db";
import { appTitle, humaniseToolName, templateTitle } from "./app-title.js";

const tool = (extra: Record<string, unknown> = {}) =>
  ({ name: "open_lakehouse_explorer", annotations: {}, ...extra }) as unknown as PinnedTool;
const page = (head: string) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;

describe("an app's title (KOBE-447)", () => {
  it("reads the pinned template's <title> as plain text", () => {
    expect(templateTitle(page("<title>Lakehouse Explorer</title>"))).toBe("Lakehouse Explorer");
    expect(templateTitle(page('<TITLE id="t">\n  Lake &amp; House\n</TITLE>'))).toBe(
      "Lake & House",
    );
    expect(templateTitle(page("<title>&lt;b&gt;Bold&#33; &#x41;</title>"))).toBe("<b>Bold! A");
    expect(templateTitle(page("<title>Lake‮house​\u0007</title>"))).toBe("Lakehouse");
    expect(templateTitle(page("<title>   </title>"))).toBeUndefined();
    expect(templateTitle(page("<meta charset=utf-8>"))).toBeUndefined();
    expect(templateTitle("<title>never closed")).toBeUndefined();
    // An <svg><title> in the body is not the page's title.
    expect(templateTitle("<html><body><svg><title>Icon</title></svg></body></html>")).toBe(
      undefined,
    );
    expect(templateTitle(page(`<title>${"x".repeat(500)}</title>`))?.length).toBeLessThanOrEqual(
      120,
    );
  });

  it("does not backtrack on hostile bytes", () => {
    const hostile = "<head>" + "<title".repeat(50_000) + "<title>".repeat(20_000);
    const started = Date.now();
    expect(templateTitle(hostile)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("humanises a tool name", () => {
    expect(humaniseToolName("open_lakehouse_explorer")).toBe("Open lakehouse explorer");
    expect(humaniseToolName("openLakehouse-explorer")).toBe("Open lakehouse explorer");
    expect(humaniseToolName("___")).toBe("___");
  });

  it("prefers the tool's title, then annotations, then the template's, then the humanised name", () => {
    expect(appTitle(tool({ title: "Explorer" }), "Lakehouse Explorer")).toBe("Explorer");
    expect(appTitle(tool({ annotations: { title: "Annotated" } }), "Lakehouse Explorer")).toBe(
      "Annotated",
    );
    expect(appTitle(tool(), "Lakehouse Explorer")).toBe("Lakehouse Explorer");
    expect(appTitle(tool(), undefined)).toBe("Open lakehouse explorer");
    expect(appTitle(tool({ title: "‮​" }), undefined)).toBe("Open lakehouse explorer");
  });
});
