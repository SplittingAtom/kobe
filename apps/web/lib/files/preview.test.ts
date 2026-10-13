import { describe, expect, it } from "vitest";
import {
  decodePreviewText,
  fileTabId,
  filePathOfTab,
  imageDataUrl,
  previewOf,
  tabDomId,
  workspaceFrameUrl,
} from "./preview";

describe("file tab ids", () => {
  it("round-trip a path and never look like an artifact id", () => {
    const id = fileTabId("notes/todo list.md");
    expect(id).toBe("file:notes/todo list.md");
    expect(filePathOfTab(id)).toBe("notes/todo list.md");
    expect(filePathOfTab("00000000-0000-4000-8000-000000000001")).toBeNull();
    expect(filePathOfTab("file:")).toBeNull();
    expect(filePathOfTab("file:/etc/passwd")).toBeNull();
    expect(filePathOfTab("file:a/../b")).toBeNull();
    expect(filePathOfTab(`file:${"a".repeat(1025)}`)).toBeNull();
  });

  it("make DOM ids without whitespace that keep distinct tabs distinct", () => {
    const a = tabDomId("file:a b/c_2f.md");
    expect(a).not.toMatch(/\s/);
    expect(a).not.toBe(tabDomId("file:a b/c/.md"));
    expect(tabDomId("00000000-0000-4000-8000-000000000001")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });
});

describe("previewOf", () => {
  it.each([
    ["README.md", "markdown"],
    ["a/b.MARKDOWN", "markdown"],
    ["data.csv", "csv"],
    ["data.tsv", "tsv"],
    ["x.json", "json"],
    ["main.py", "code"],
    ["app.TS", "code"],
    ["notes.txt", "text"],
    ["run.log", "text"],
    ["Dockerfile", "code"],
    ["pic.png", "image"],
    ["pic.JPEG", "image"],
    ["anim.gif", "image"],
    ["p.webp", "image"],
    ["logo.svg", "svg"],
    ["index.html", "html"],
    ["old.htm", "html"],
    ["doc.pdf", "none"],
    ["archive.zip", "none"],
    ["noext", "none"],
  ])("%s is %s", (path, kind) => {
    expect(previewOf(path).kind).toBe(kind);
  });

  it("names the language of code and the image type", () => {
    expect(previewOf("main.py")).toEqual({ kind: "code", language: "python" });
    expect(previewOf("pic.jpg")).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(previewOf("logo.svg")).toEqual({ kind: "svg", mime: "image/svg+xml" });
  });
});

describe("decodePreviewText", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("decodes UTF-8 and refuses binary", () => {
    expect(decodePreviewText(enc("héllo"), false)).toBe("héllo");
    expect(decodePreviewText(new Uint8Array([0x68, 0x00, 0x69]), false)).toBeNull();
    expect(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x41]), false)).toBeNull();
  });

  it("drops a character cut in half by the cap", () => {
    const cut = enc("ab€").slice(0, 3); // "ab" + the first byte of "€"
    expect(decodePreviewText(cut, true)).toBe("ab");
    expect(decodePreviewText(cut, false)).toBeNull();
  });
});

describe("urls", () => {
  it("builds the frame url with the team in the query", () => {
    expect(workspaceFrameUrl("site/a b.html", "t-1")).toBe(
      "/v1/workspace/frame?path=site%2Fa+b.html&team=t-1",
    );
  });

  it("makes data urls for images (the page CSP allows data:, not blob:)", () => {
    expect(imageDataUrl(new Uint8Array([1, 2, 3]), "image/png")).toBe("data:image/png;base64,AQID");
  });
});
