import { describe, expect, it } from "vitest";
import { approveTemplatesPure, reviewOfTemplate } from "./template-review.js";
import {
  applyTemplateDrift,
  liveTemplates,
  type LiveEntry,
  type StoredTemplate,
} from "./templates.js";

const MIME = "text/html;profile=mcp-app";
const live = (uri: string, text: string): LiveEntry => {
  const [e] = liveTemplates(
    [{ ui: { resource_uri: uri } }],
    [{ uri, mimeType: MIME, text, meta: {} }],
  );
  if (!e) throw new Error("fixture");
  return e;
};
const pinned = (uri: string, text: string): StoredTemplate => {
  const e = live(uri, text);
  if (!("html" in e)) throw new Error("fixture");
  return { ...e, status: "pinned", approved: true };
};
const hashOf = (e: LiveEntry) => ("pinnedHash" in e ? e.pinnedHash : "");

describe("template review (KOBE-434)", () => {
  const changed = applyTemplateDrift(
    [pinned("ui://c/a", "v1")],
    [live("ui://c/a", "v2")],
  ).templates;
  const added = applyTemplateDrift([], [live("ui://c/n", "n")]).templates;
  const invalidNew = applyTemplateDrift(
    [],
    [{ uri: "ui://c/x", invalid: "ui_resource_invalid" }],
  ).templates;

  it("shows approved and live versions without the bytes", () => {
    expect(reviewOfTemplate(must(changed[0]))).toMatchObject({
      uri: "ui://c/a",
      status: "drifted",
      change: "changed",
      approved: { bytes: 2, mimeType: MIME },
      live: { bytes: 2, pinnedHash: hashOf(live("ui://c/a", "v2")) },
    });
    expect(reviewOfTemplate(must(added[0]))).toMatchObject({ change: "added", live: { bytes: 1 } });
    expect(reviewOfTemplate(must(added[0]))).not.toHaveProperty("approved");
    expect(reviewOfTemplate(must(invalidNew[0]))).toEqual({
      uri: "ui://c/x",
      status: "drifted",
      change: "invalid",
      invalid: "ui_resource_invalid",
    });
    expect(JSON.stringify(reviewOfTemplate(must(changed[0])))).not.toContain("v2");
  });

  it("approves a changed or new template by the reviewed hash", () => {
    const r = approveTemplatesPure(
      [...changed, ...added],
      [
        { uri: "ui://c/a", pinnedHash: hashOf(live("ui://c/a", "v2")) },
        { uri: "ui://c/n", pinnedHash: hashOf(live("ui://c/n", "n")) },
      ],
    );
    expect(r.ok && r.templates.map((t) => [t.uri, t.status, t.approved, t.html])).toEqual([
      ["ui://c/a", "pinned", true, "v2"],
      ["ui://c/n", "pinned", true, "n"],
    ]);
    expect(r.ok && r.templates[0]).not.toHaveProperty("proposed");
  });

  it("refuses a stale hash, a template not pending and an invalid one, all or nothing (ac-1)", () => {
    expect(
      approveTemplatesPure(changed, [
        { uri: "ui://c/a", pinnedHash: hashOf(live("ui://c/a", "v1")) },
      ]),
    ).toEqual({ ok: false, error: "stale", uri: "ui://c/a" });
    expect(
      approveTemplatesPure(
        [pinned("ui://c/p", "p")],
        [{ uri: "ui://c/p", pinnedHash: "a".repeat(64) }],
      ),
    ).toEqual({ ok: false, error: "not_pending", uri: "ui://c/p" });
    expect(
      approveTemplatesPure(invalidNew, [
        { uri: "ui://c/x", pinnedHash: must(invalidNew[0]).pinnedHash },
      ]),
    ).toEqual({ ok: false, error: "invalid", uri: "ui://c/x" });
    const turned = applyTemplateDrift(
      [pinned("ui://c/a", "v1")],
      [{ uri: "ui://c/a", invalid: "ui_resource_hash_mismatch" }],
    ).templates;
    expect(
      approveTemplatesPure(turned, [{ uri: "ui://c/a", pinnedHash: must(turned[0]).pinnedHash }]),
    ).toEqual({ ok: false, error: "invalid", uri: "ui://c/a" });
  });

  it("re-validates the bytes before approving them", () => {
    const tampered: StoredTemplate = { ...must(added[0]), html: "a\u0000b" };
    expect(
      approveTemplatesPure([tampered], [{ uri: "ui://c/n", pinnedHash: tampered.pinnedHash }]),
    ).toEqual({ ok: false, error: "invalid", uri: "ui://c/n" });
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}
