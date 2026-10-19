import { describe, expect, it } from "vitest";
import {
  parseProposedUiResource,
  UI_RESOURCE_URI_PATTERN,
  uiResourceMetaSchema,
} from "./ui-resources.js";
import { parseToolsSnapshot } from "./snapshot.js";

const live = {
  mime_type: "text/html;profile=mcp-app",
  html: "<html></html>",
  sha256: "a".repeat(64),
  meta: { prefersBorder: false },
  pinned_hash: "b".repeat(64),
};

describe("ui:// resources (KOBE-433)", () => {
  it("accepts ui:// URIs only", () => {
    expect(UI_RESOURCE_URI_PATTERN.test("ui://catalyst/lakehouse-explorer")).toBe(true);
    for (const bad of [
      "https://x/y",
      "ui://",
      "ui://a b",
      "UI://x",
      "file:///etc/passwd",
      "ui://a\u0000b",
      "ui://a\u0001b",
      "ui://é",
    ]) {
      expect(UI_RESOURCE_URI_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("keeps only the declared _meta.ui keys", () => {
    expect(
      uiResourceMetaSchema.parse({ csp: { connectDomains: [] }, prefersBorder: true, other: 1 }),
    ).toEqual({ csp: { connectDomains: [] }, prefersBorder: true });
  });

  it("parses a proposal or an invalid marker, and nothing else", () => {
    expect(parseProposedUiResource(live)).toEqual(live);
    expect(parseProposedUiResource({ invalid: "ui_resource_hash_mismatch" })).toEqual({
      invalid: "ui_resource_hash_mismatch",
    });
    expect(parseProposedUiResource(null)).toBeUndefined();
    expect(parseProposedUiResource({ ...live, sha256: "x" })).toBeUndefined();
    expect(parseProposedUiResource({ invalid: "other" })).toBeUndefined();
  });

  it("keeps a tool's ui:// template reference and drops a malformed one (fail closed)", () => {
    const tool = {
      name: "open",
      pi_name: "mcp__c__open",
      input_schema: { type: "object" },
      sha256: "a".repeat(64),
      status: "pinned",
    };
    const [kept] = parseToolsSnapshot([{ ...tool, ui: { resource_uri: "ui://c/app" } }]);
    expect(kept?.ui).toEqual({ resource_uri: "ui://c/app" });
    expect(parseToolsSnapshot([{ ...tool, ui: { resource_uri: "https://x" } }])).toEqual([]);
    const [visible] = parseToolsSnapshot([{ ...tool, ui: { visibility: ["app"] } }]);
    expect(visible?.ui).toEqual({ visibility: ["app"] });
    expect(parseToolsSnapshot([{ ...tool, ui: { visibility: ["user"] } }])).toEqual([]);
  });
});
