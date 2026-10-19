import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeUpstream } from "./testing/fake-upstream.js";
import {
  MAX_UI_RESOURCES,
  UI_RESOURCE_MAX_BYTES,
  UI_RESOURCE_META_MAX_BYTES,
} from "./ui-resources.js";
import { createUpstreamClient, type UpstreamClient } from "./upstream.js";

/** The pin probe's `ui://` templates (KOBE-433, mcp-apps-host §5): read only what tools name. */
const MIME = "text/html;profile=mcp-app";
const fake = new FakeUpstream();
let client: UpstreamClient;

beforeAll(async () => {
  await fake.start();
  client = createUpstreamClient({
    policy: {
      allowInsecureHttp: true,
      allowedPorts: [Number(new URL(fake.url).port)],
      allowedInternalCidrs: ["127.0.0.0/8"],
      deniedCidrs: [],
    },
    maxResponseBytes: 2 * 1024 * 1024,
  });
});
afterAll(async () => {
  await client.close();
  await fake.stop();
});
beforeEach(() => {
  fake.received.length = 0;
  fake.options = {};
});

const tool = (name: string, resourceUri?: unknown) => ({
  name,
  inputSchema: { type: "object" },
  ...(resourceUri === undefined ? {} : { _meta: { ui: { resourceUri } } }),
});
const probe = (uiResources = true) =>
  client.listTools(
    { url: fake.url, headers: {}, signal: AbortSignal.timeout(5_000) },
    { uiResources },
  );
const methods = () => fake.received.map((r) => r.method);

describe("listTools with ui resources", () => {
  it("reads only the listed ui:// templates the live tools name, with their _meta", async () => {
    fake.options = {
      tools: [tool("open", "ui://c/app"), tool("other", "ui://c/gone"), tool("plain")],
      resources: [
        {
          uri: "ui://c/app",
          mimeType: MIME,
          text: "<p>app</p>",
          _meta: { ui: { prefersBorder: false } },
          contentMeta: { "io.splittingatom/contentHash": "abc" },
        },
        { uri: "ui://c/gone", mimeType: MIME, text: "x", unlisted: true },
        { uri: "ui://c/unused", mimeType: MIME, text: "y" },
      ],
    };
    const res = await probe();
    expect(res).toEqual({
      ok: true,
      result: {
        tools: expect.any(Array),
        ui_resources: [
          {
            uri: "ui://c/app",
            mimeType: MIME,
            text: "<p>app</p>",
            meta: { ui: { prefersBorder: false }, "io.splittingatom/contentHash": "abc" },
          },
        ],
      },
    });
    expect(methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "resources/list",
      "resources/read",
    ]);
    expect(fake.received.at(-1)?.message.params).toEqual({ uri: "ui://c/app" });
  });

  it("asks for nothing more without the option, or when no tool names a ui:// template", async () => {
    fake.options = {
      tools: [tool("open", "ui://c/app")],
      resources: [{ uri: "ui://c/app", text: "x" }],
    };
    expect(await probe(false)).toEqual({ ok: true, result: { tools: expect.any(Array) } });
    expect(methods()).not.toContain("resources/list");
    fake.received.length = 0;
    fake.options = { tools: [tool("a", "https://x.example/app"), tool("b", 7)], resources: [] };
    expect(await probe()).toEqual({
      ok: true,
      result: { tools: expect.any(Array), ui_resources: [] },
    });
    expect(methods()).not.toContain("resources/list");
  });

  it("treats a server without resources as having no templates", async () => {
    fake.options = { tools: [tool("open", "ui://c/app")] };
    expect(await probe()).toEqual({
      ok: true,
      result: { tools: expect.any(Array), ui_resources: [] },
    });
  });

  it("reports a template that is too large, unreadable or not UTF-8 per template", async () => {
    fake.options = {
      tools: [
        tool("a", "ui://c/big"),
        tool("b", "ui://c/blob"),
        tool("c", "ui://c/bad"),
        tool("d", "ui://c/ok"),
      ],
      resources: [
        { uri: "ui://c/big", mimeType: MIME, text: "x".repeat(UI_RESOURCE_MAX_BYTES + 1) },
        { uri: "ui://c/blob", mimeType: MIME, blob: Buffer.from([0xff, 0xfe]).toString("base64") },
        { uri: "ui://c/bad", mimeType: MIME },
        { uri: "ui://c/ok", mimeType: MIME, blob: Buffer.from("<b>é</b>").toString("base64") },
      ],
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([
      { uri: "ui://c/big", error: "too_large" },
      { uri: "ui://c/blob", error: "invalid" },
      { uri: "ui://c/bad", error: "invalid" },
      { uri: "ui://c/ok", mimeType: MIME, text: "<b>é</b>", meta: {} },
    ]);
  });

  it("refuses text that is not valid UTF-8 (a lone surrogate)", async () => {
    fake.options = {
      tools: [tool("a", "ui://c/app")],
      resources: [{ uri: "ui://c/app", mimeType: MIME, text: "ok \ud800" }],
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([{ uri: "ui://c/app", error: "invalid" }]);
  });

  it("reports a refused read per template", async () => {
    fake.options = {
      tools: [tool("a", "ui://c/app")],
      resources: [{ uri: "ui://c/app", mimeType: MIME, text: "x" }],
      readError: true,
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([{ uri: "ui://c/app", error: "invalid" }]);
  });

  it("reads at most MAX_UI_RESOURCES and reports the rest as invalid, never failing the tools", async () => {
    const uris = Array.from({ length: MAX_UI_RESOURCES + 2 }, (_, i) => `ui://c/${i}`);
    fake.options = {
      tools: uris.map((u, i) => tool(`t${i}`, u)),
      resources: uris.map((uri) => ({ uri, mimeType: MIME, text: "x" })),
    };
    const res = await probe();
    if (!res.ok) throw new Error("probe failed");
    const ui = res.result.ui_resources as { uri: string; error?: string }[];
    expect(ui.filter((r) => r.error === undefined)).toHaveLength(MAX_UI_RESOURCES);
    expect(ui.slice(MAX_UI_RESOURCES)).toEqual([
      { uri: `ui://c/${MAX_UI_RESOURCES}`, error: "invalid" },
      { uri: `ui://c/${MAX_UI_RESOURCES + 1}`, error: "invalid" },
    ]);
    expect(methods().filter((m) => m === "resources/read")).toHaveLength(MAX_UI_RESOURCES);
  });

  it("skips the template part, keeping the tools, when resources/list fails or never ends", async () => {
    fake.options = {
      tools: [tool("open", "ui://c/app")],
      resources: [{ uri: "ui://c/app", mimeType: MIME, text: "x" }],
      listErrorCode: -32603,
    };
    expect(await probe()).toEqual({
      ok: true,
      result: { tools: expect.any(Array), ui_resources_skipped: "rpc_error" },
    });
    fake.options = {
      tools: [tool("open", "ui://c/app")],
      resources: [{ uri: "ui://c/app", mimeType: MIME, text: "x" }],
      endlessResources: true,
    };
    expect(await probe()).toEqual({
      ok: true,
      result: { tools: expect.any(Array), ui_resources_skipped: "too_large" },
    });
  });

  it("reports a read too large for the response cap as that template's error", async () => {
    fake.options = {
      tools: [tool("a", "ui://c/huge"), tool("b", "ui://c/ok")],
      resources: [
        { uri: "ui://c/huge", mimeType: MIME, text: "x".repeat(3 * 1024 * 1024) },
        { uri: "ui://c/ok", mimeType: MIME, text: "ok" },
      ],
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([
      { uri: "ui://c/huge", error: "too_large" },
      { uri: "ui://c/ok", mimeType: MIME, text: "ok", meta: {} },
    ]);
  });

  it("passes on only the ui and contentHash _meta keys, and refuses an oversized _meta", async () => {
    fake.options = {
      tools: [tool("a", "ui://c/a"), tool("b", "ui://c/b")],
      resources: [
        {
          uri: "ui://c/a",
          mimeType: MIME,
          text: "a",
          _meta: { ui: { prefersBorder: true }, junk: "x".repeat(10_000) },
          contentMeta: { "io.splittingatom/contentHash": "h", other: 1 },
        },
        {
          uri: "ui://c/b",
          mimeType: MIME,
          text: "b",
          contentMeta: { ui: { csp: "x".repeat(UI_RESOURCE_META_MAX_BYTES) } },
        },
        // Listed but named by no tool: its _meta is never kept.
        { uri: "ui://c/unnamed", mimeType: MIME, text: "u", _meta: { ui: "x".repeat(100_000) } },
      ],
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([
      {
        uri: "ui://c/a",
        mimeType: MIME,
        text: "a",
        meta: { ui: { prefersBorder: true }, "io.splittingatom/contentHash": "h" },
      },
      { uri: "ui://c/b", error: "invalid" },
    ]);
  });

  it("refuses a read whose content names another URI, and never reads a non-ui:// URI", async () => {
    fake.options = {
      tools: [
        tool("a", "ui://c/a"),
        tool("b", "https://x.example/app"),
        tool("c", "ui://c/a\u0001"),
      ],
      resources: [{ uri: "ui://c/a", mimeType: MIME, text: "a" }],
      readUri: "ui://c/other",
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([{ uri: "ui://c/a", error: "invalid" }]);
    const reads = fake.received.filter((r) => r.method === "resources/read");
    expect(reads.map((r) => r.message.params)).toEqual([{ uri: "ui://c/a" }]);
  });

  it("keeps a leading BOM of a blob and refuses a blob that is not strict base64", async () => {
    const bom = "\ufeff<p>x</p>";
    fake.options = {
      tools: [tool("a", "ui://c/bom"), tool("b", "ui://c/junk")],
      resources: [
        { uri: "ui://c/bom", mimeType: MIME, blob: Buffer.from(bom, "utf8").toString("base64") },
        { uri: "ui://c/junk", mimeType: MIME, blob: "PHA+!!!" },
      ],
    };
    const res = await probe();
    expect(res.ok && res.result.ui_resources).toEqual([
      { uri: "ui://c/bom", mimeType: MIME, text: bom, meta: {} },
      { uri: "ui://c/junk", error: "invalid" },
    ]);
  });
});
