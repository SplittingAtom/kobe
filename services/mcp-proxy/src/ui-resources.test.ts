import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeUpstream } from "./testing/fake-upstream.js";
import { MAX_UI_RESOURCES, UI_RESOURCE_MAX_BYTES } from "./ui-resources.js";
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

  it("refuses more templates than it reads in one probe", async () => {
    const uris = Array.from({ length: MAX_UI_RESOURCES + 1 }, (_, i) => `ui://c/${i}`);
    fake.options = {
      tools: uris.map((u, i) => tool(`t${i}`, u)),
      resources: uris.map((uri) => ({ uri, mimeType: MIME, text: "x" })),
    };
    expect(await probe()).toEqual({ ok: false, failure: "too_large" });
  });
});
