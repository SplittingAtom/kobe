import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyTemplateDrift,
  liveTemplates,
  pinTemplates,
  type LiveEntry,
  type StoredTemplate,
} from "./templates.js";

const MIME = "text/html;profile=mcp-app";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const raw = (uri: string, text: string, meta: Record<string, unknown> = {}) => ({
  uri,
  mimeType: MIME,
  text,
  meta,
});
const tools = (...uris: string[]) => uris.map((u) => ({ ui: { resource_uri: u } }));

describe("liveTemplates (KOBE-433)", () => {
  it("hashes each named template itself and keeps only the declared _meta.ui keys", () => {
    const html = "<p>é</p>";
    const [entry] = liveTemplates(tools("ui://c/app"), [
      raw("ui://c/app", html, {
        ui: { prefersBorder: false, csp: { connectDomains: ["x"] }, other: 1 },
        "io.splittingatom/contentHash": sha(html),
      }),
    ]);
    expect(entry).toMatchObject({
      uri: "ui://c/app",
      mimeType: MIME,
      html,
      sha256: sha(html),
      meta: { prefersBorder: false, csp: { connectDomains: ["x"] } },
    });
    expect(entry && "pinnedHash" in entry && entry.pinnedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops templates no tool names", () => {
    expect(
      liveTemplates(tools("ui://c/a"), [raw("ui://c/a", "a"), raw("ui://c/b", "b")]),
    ).toHaveLength(1);
  });

  it("changes the pinned hash when the bytes or the declared _meta.ui change", () => {
    const hash = (text: string, meta = {}) => {
      const [e] = liveTemplates(tools("ui://c/a"), [raw("ui://c/a", text, meta)]);
      return e && "pinnedHash" in e ? e.pinnedHash : "";
    };
    expect(hash("a")).toBe(hash("a", { other: 1 }));
    expect(hash("a")).not.toBe(hash("b"));
    expect(hash("a")).not.toBe(hash("a", { ui: { csp: { connectDomains: ["evil"] } } }));
  });

  it("marks a contentHash mismatch, a wrong type, too many bytes and a proxy error", () => {
    const entries = liveTemplates(
      tools("ui://c/1", "ui://c/2", "ui://c/3", "ui://c/4", "ui://c/5"),
      [
        raw("ui://c/1", "a", { "io.splittingatom/contentHash": sha("b") }),
        { ...raw("ui://c/2", "a"), mimeType: "text/html" },
        raw("ui://c/3", "é".repeat(256 * 1024 + 1)),
        { uri: "ui://c/4", error: "too_large" },
        { uri: "ui://c/5", error: "invalid" },
      ],
    );
    expect(entries).toEqual([
      { uri: "ui://c/1", invalid: "ui_resource_hash_mismatch" },
      { uri: "ui://c/2", invalid: "ui_resource_invalid" },
      { uri: "ui://c/3", invalid: "ui_resource_invalid" },
      { uri: "ui://c/4", invalid: "ui_resource_invalid" },
      { uri: "ui://c/5", invalid: "ui_resource_invalid" },
    ]);
  });

  it("accepts a sha256:-prefixed or upper-case contentHash that matches", () => {
    const [a] = liveTemplates(tools("ui://c/a"), [
      raw("ui://c/a", "a", { "io.splittingatom/contentHash": `sha256:${sha("a").toUpperCase()}` }),
    ]);
    expect(a && "html" in a).toBe(true);
  });

  it("ignores entries that do not parse", () => {
    expect(liveTemplates(tools("ui://c/a"), [{ uri: 7 }, null, "x"])).toEqual([]);
  });
});

describe("pinTemplates", () => {
  it("is all or nothing: the first invalid template fails the pin with its code", () => {
    const good = liveTemplates(tools("ui://c/a"), [raw("ui://c/a", "a")]);
    expect(pinTemplates(good)).toMatchObject({ ok: true, templates: [{ uri: "ui://c/a" }] });
    const bad: LiveEntry[] = [...good, { uri: "ui://c/b", invalid: "ui_resource_hash_mismatch" }];
    expect(pinTemplates(bad)).toEqual({
      ok: false,
      failure: "ui_resource_hash_mismatch",
      uri: "ui://c/b",
    });
  });
});

describe("applyTemplateDrift", () => {
  const live = (uri: string, text: string): LiveEntry => {
    const [e] = liveTemplates(tools(uri), [raw(uri, text)]);
    if (!e) throw new Error("fixture");
    return e;
  };
  const pinned = (uri: string, text: string): StoredTemplate => {
    const e = live(uri, text);
    if (!("html" in e)) throw new Error("fixture");
    return { ...e, status: "pinned" };
  };

  it("keeps unchanged templates and reports nothing", () => {
    const r = applyTemplateDrift([pinned("ui://c/a", "a")], [live("ui://c/a", "a")]);
    expect(r).toEqual({
      templates: [pinned("ui://c/a", "a")],
      changed: [],
      added: [],
      removed: [],
    });
  });

  it("drifts a changed template, keeping the approved bytes and proposing the live ones", () => {
    const r = applyTemplateDrift([pinned("ui://c/a", "a")], [live("ui://c/a", "<script>evil")]);
    expect(r.changed).toEqual(["ui://c/a"]);
    expect(r.templates[0]).toMatchObject({
      status: "drifted",
      html: "a",
      proposed: { html: "<script>evil", sha256: sha("<script>evil") },
    });
    // The same live bytes again: no new event; back to the approved bytes: pinned again.
    expect(applyTemplateDrift(r.templates, [live("ui://c/a", "<script>evil")]).changed).toEqual([]);
    const back = applyTemplateDrift(r.templates, [live("ui://c/a", "a")]);
    expect(back.templates).toEqual([pinned("ui://c/a", "a")]);
  });

  it("drifts an approved template whose live one is invalid, with the reason", () => {
    const r = applyTemplateDrift(
      [pinned("ui://c/a", "a")],
      [{ uri: "ui://c/a", invalid: "ui_resource_invalid" }],
    );
    expect(r.changed).toEqual(["ui://c/a"]);
    expect(r.templates[0]).toMatchObject({
      status: "drifted",
      html: "a",
      proposed: { invalid: "ui_resource_invalid" },
    });
  });

  it("adds a new template as drifted, which then follows the live bytes", () => {
    const r = applyTemplateDrift([], [live("ui://c/n", "n1")]);
    expect(r.added).toEqual(["ui://c/n"]);
    expect(r.templates[0]).toMatchObject({ status: "drifted", html: "n1" });
    expect(r.templates[0]).not.toHaveProperty("proposed");
    const again = applyTemplateDrift(r.templates, [live("ui://c/n", "n2")]);
    expect(again).toMatchObject({ changed: [], added: [], removed: [] });
    expect(again.templates[0]).toMatchObject({ status: "drifted", html: "n2" });
  });

  it("never adds an invalid new template, and removes a new one that turned invalid", () => {
    expect(applyTemplateDrift([], [{ uri: "ui://c/n", invalid: "ui_resource_invalid" }])).toEqual({
      templates: [],
      changed: [],
      added: [],
      removed: [],
    });
    const added = applyTemplateDrift([], [live("ui://c/n", "n")]).templates;
    const r = applyTemplateDrift(added, [{ uri: "ui://c/n", invalid: "ui_resource_invalid" }]);
    expect(r).toMatchObject({ templates: [], removed: ["ui://c/n"] });
  });

  it("removes a template the server no longer lists", () => {
    const r = applyTemplateDrift([pinned("ui://c/a", "a")], []);
    expect(r).toEqual({ templates: [], changed: [], added: [], removed: ["ui://c/a"] });
  });
});
