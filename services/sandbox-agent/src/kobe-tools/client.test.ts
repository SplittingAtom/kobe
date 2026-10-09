import type { Duplex } from "node:stream";
import { socketPair } from "../testing/socket-pair.js";
import { describe, expect, it } from "vitest";
import { ToolsClient } from "./client.js";
import { MAX_PENDING_REQUESTS, MAX_REPLY_LINE_BYTES } from "./protocol.js";

const CALL = {
  op: "artifact.put",
  tool_call_id: "call_1",
  tool: "create_artifact",
  input: { kind: "markdown", title: "t", content: "# hi" },
} as const;

async function setup(timeoutMs = 1000) {
  const [extensionEnd, agentEnd] = await socketPair();
  const requests: Record<string, unknown>[] = [];
  let buffer = "";
  agentEnd.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      requests.push(JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>);
      buffer = buffer.slice(lf + 1);
    }
  });
  const client = new ToolsClient(extensionEnd, { timeoutMs });
  const reply = (v: unknown) => agentEnd.write(`${JSON.stringify(v)}\n`);
  const waitFor = async (n: number) => {
    for (let i = 0; i < 200 && requests.length < n; i += 1)
      await new Promise((r) => setImmediate(r));
  };
  return { client, requests, reply, agentEnd: agentEnd as Duplex, waitFor };
}

describe("ToolsClient", () => {
  it("sends the request with a fresh id and returns the ok result", async () => {
    const t = await setup();
    const result = t.client.request(CALL);
    await t.waitFor(1);
    expect(t.requests[0]).toEqual({ id: "kt_1", ...CALL });
    t.reply({ id: "kt_1", ok: true, artifact_id: "a1", version: 2 });
    expect(await result).toEqual({ ok: true, artifact_id: "a1", version: 2 });
  });

  it("returns the server's error", async () => {
    const t = await setup();
    const result = t.client.request(CALL);
    await t.waitFor(1);
    t.reply({ id: "kt_1", ok: false, error: { code: "not_found", message: "no such artifact" } });
    expect(await result).toEqual({
      ok: false,
      error: { code: "not_found", message: "no such artifact" },
    });
  });

  it("answers concurrent requests by id", async () => {
    const t = await setup();
    const a = t.client.request(CALL);
    const b = t.client.request({ ...CALL, tool_call_id: "call_2" });
    await t.waitFor(2);
    t.reply({ id: "kt_2", ok: true, artifact_id: "b", version: 1 });
    t.reply({ id: "kt_1", ok: true, artifact_id: "a", version: 1 });
    expect(await a).toMatchObject({ artifact_id: "a" });
    expect(await b).toMatchObject({ artifact_id: "b" });
  });

  it("times out as an error and drops a late answer", async () => {
    const t = await setup(30);
    const result = await t.client.request(CALL);
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(t.client.closed).toBe(false);
    t.reply({ id: "kt_1", ok: true, artifact_id: "a", version: 1 });
  });

  it("fails every pending request when the channel closes, and every later one", async () => {
    const t = await setup();
    const pending = t.client.request(CALL);
    await t.waitFor(1);
    t.agentEnd.destroy();
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await t.client.request(CALL)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it.each([
    ["not JSON", "not json"],
    ["no id", JSON.stringify({ ok: true, artifact_id: "a", version: 1 })],
    ["bad version", JSON.stringify({ id: "kt_1", ok: true, artifact_id: "a", version: "1" })],
    ["bad error", JSON.stringify({ id: "kt_1", ok: false, error: "x" })],
  ])("closes on a malformed reply (%s)", async (_name, line) => {
    const t = await setup();
    const pending = t.client.request(CALL);
    await t.waitFor(1);
    t.agentEnd.write(`${line}\n`);
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(t.client.closed).toBe(true);
  });

  it("returns a file.share reply with its fields", async () => {
    const t = await setup();
    const pending = t.client.request({
      op: "file.share",
      tool_call_id: "c",
      tool: "share_file",
      input: { path: "a.csv" },
    });
    await t.waitFor(1);
    const file = {
      file_id: "f1",
      name: "a.csv",
      mime_type: "text/csv",
      size_bytes: 8,
      scan: "clean",
      created_at: "2026-10-09T10:00:00.000Z",
      sha256: "a".repeat(64),
    };
    t.reply({ id: "kt_1", ok: true, ...file });
    expect(await pending).toEqual({ ok: true, ...file });
  });

  it("closes on a file reply with a missing field", async () => {
    const t = await setup();
    const pending = t.client.request(CALL);
    await t.waitFor(1);
    t.agentEnd.write(`${JSON.stringify({ id: "kt_1", ok: true, file_id: "f1", name: "a" })}\n`);
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(t.client.closed).toBe(true);
  });

  it("closes on an oversize reply line", async () => {
    const t = await setup();
    const pending = t.client.request(CALL);
    await t.waitFor(1);
    t.agentEnd.write("x".repeat(MAX_REPLY_LINE_BYTES + 1));
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("refuses beyond the in-flight cap", async () => {
    const t = await setup();
    const first = Array.from({ length: MAX_PENDING_REQUESTS }, () => t.client.request(CALL));
    expect(await t.client.request(CALL)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    t.agentEnd.destroy();
    await Promise.all(first);
  });
});
