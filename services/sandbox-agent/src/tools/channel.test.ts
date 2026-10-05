import type { Duplex } from "node:stream";
import { socketPair } from "../testing/socket-pair.js";
import { describe, expect, it } from "vitest";
import { ToolsChannel, TOOLS_CHANNEL_MAX_LINE_BYTES } from "./channel.js";

const PUT = {
  id: "kt_1",
  op: "artifact.put",
  tool_call_id: "call_1",
  tool: "create_artifact",
  input: { kind: "markdown", title: "t", content: "# hi" },
};

async function setup() {
  const [agentEnd, extensionEnd] = await socketPair();
  const received: Record<string, unknown>[] = [];
  let buffer = "";
  extensionEnd.on("data", (c: Buffer) => {
    buffer += c.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      received.push(JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>);
      buffer = buffer.slice(lf + 1);
    }
  });
  const requests: unknown[] = [];
  const closed: string[] = [];
  const channel = new ToolsChannel(agentEnd, {
    onRequest: (r, reply) => {
      requests.push(r);
      reply({
        id: r.id,
        ok: true,
        artifact_id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      });
    },
    onClosed: (r) => closed.push(r),
  });
  const send = (v: unknown) =>
    extensionEnd.write(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
  const tick = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { channel, received, requests, closed, send, tick, extensionEnd: extensionEnd as Duplex };
}

describe("ToolsChannel", () => {
  it("hands a valid artifact.put to the handler and writes its reply", async () => {
    const t = await setup();
    t.send(PUT);
    await t.tick();
    expect(t.requests).toEqual([PUT]);
    expect(t.received).toEqual([
      { id: "kt_1", ok: true, artifact_id: "11111111-1111-4111-8111-111111111111", version: 1 },
    ]);
  });

  it("answers an invalid request that has an id with invalid_input, without calling the handler", async () => {
    const t = await setup();
    t.send({ ...PUT, input: { kind: "nope", title: "t", content: "x" } });
    t.send({ ...PUT, id: "kt_2", op: "share_file" });
    await t.tick();
    expect(t.requests).toEqual([]);
    expect(t.received).toMatchObject([
      { id: "kt_1", ok: false, error: { code: "invalid_input" } },
      { id: "kt_2", ok: false, error: { code: "invalid_input" } },
    ]);
    expect(t.channel.closed).toBe(false);
  });

  it("refuses a request that names another run or thread", async () => {
    const t = await setup();
    t.send({ ...PUT, run_id: "22222222-2222-4222-8222-222222222222" });
    await t.tick();
    expect(t.requests).toEqual([]);
    expect(t.received).toMatchObject([{ ok: false, error: { code: "invalid_input" } }]);
  });

  it("closes on a line that is not JSON", async () => {
    const t = await setup();
    t.send("garbage");
    await t.tick();
    expect(t.closed).toEqual(["malformed kobe-tools request"]);
    expect(t.channel.closed).toBe(true);
  });

  it("closes on an oversize line", async () => {
    const t = await setup();
    t.extensionEnd.write("x".repeat(TOOLS_CHANNEL_MAX_LINE_BYTES + 1) + "\n");
    await t.tick();
    expect(t.closed).toEqual(["oversize kobe-tools request"]);
  });

  it("reports the close once when the extension end goes away", async () => {
    const t = await setup();
    t.extensionEnd.destroy();
    await t.tick();
    expect(t.closed).toEqual(["kobe-tools channel closed"]);
  });
});
