import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mirrorHttpClient } from "./http-client.js";

describe("overall deadline (KOBE-344 review)", () => {
  it("cuts a request whose answer trickles in past the deadline, though never idle", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(16)), 50);
      res.on("close", () => clearInterval(t));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.zip`;
    const http = mirrorHttpClient({
      remote: url,
      credentials: null,
      proxy: null,
      allowInsecureHttp: true,
      timeoutMs: 60_000,
      deadlineAt: Date.now() + 400,
    });
    const started = Date.now();
    const res = await http.request({ url });
    const read = async () => {
      for await (const _ of res.body ?? []) void _;
    };
    await expect(read()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    // Past the deadline nothing new starts.
    await expect(http.request({ url })).rejects.toThrow(/took too long/);
    server.closeAllConnections();
    server.close();
  });
});
