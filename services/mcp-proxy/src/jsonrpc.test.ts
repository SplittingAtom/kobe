import { describe, expect, it } from "vitest";
import { parseMessage } from "./jsonrpc.js";

describe("parseMessage", () => {
  it("classifies requests, notifications and responses", () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      ok: true,
      message: { kind: "request", id: 1, method: "ping", params: undefined },
    });
    expect(parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toMatchObject({
      ok: true,
      message: { kind: "notification" },
    });
    expect(parseMessage('{"jsonrpc":"2.0","id":"a","result":{}}')).toMatchObject({
      ok: true,
      message: { kind: "response" },
    });
  });

  it.each([
    ["invalid JSON", "{", -32700],
    ["duplicate keys", '{"jsonrpc":"2.0","id":1,"method":"a","method":"b"}', -32700],
    ["U+0000", '{"jsonrpc":"2.0","id":1,"method":"a\\u0000"}', -32700],
    ["__proto__", '{"jsonrpc":"2.0","id":1,"method":"a","params":{"__proto__":{}}}', -32700],
    ["a batch", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600],
    ["no version", '{"id":1,"method":"ping"}', -32600],
    ["an object id", '{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600],
    ["an unsafe numeric id", '{"jsonrpc":"2.0","id":1e300,"method":"ping"}', -32600],
    ["an empty method", '{"jsonrpc":"2.0","id":1,"method":""}', -32600],
    ["neither method nor result", '{"jsonrpc":"2.0","id":1}', -32600],
  ])("refuses %s", (_, text, code) => {
    expect(parseMessage(text)).toMatchObject({ ok: false, code });
  });
});
