import { describe, expect, it } from "vitest";
import { SessionClient } from "./exchange.js";
import { sessionTokenKeeper } from "./keepers.js";

const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const tok = (aud: string, n: number) => `${aud}.${"x".repeat(30)}.${n}`;
const quiet = { info: () => undefined, warn: () => undefined, debug: () => undefined };

function session() {
  let trades = 0;
  const client = new SessionClient({
    serverUrl: "ws://server.kobe.internal:8081",
    bootstrapTokenFile: "/var/run/secrets/kobe/bootstrap-token",
    readFile: async () => "bootstrap",
    fetch: (async () => {
      trades += 1;
      return new Response(
        JSON.stringify({
          sandbox_id: SANDBOX,
          team_id: TEAM,
          user_id: USER,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          tokens: {
            "kobe.sandbox-wire": tok("wire", trades),
            "kobe.model-gateway": tok("gw", trades),
            "kobe.mcp-proxy": tok("mcp", trades),
            "kobe.egress-proxy": tok("egress", trades),
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    logger: quiet,
  });
  return { client, trades: () => trades };
}

describe("sessionTokenKeeper (index.ts wiring, KOBE-522)", () => {
  it("hands the MCP and egress keepers the re-traded tokens after a wire rejection", async () => {
    const s = session();
    const mcp = sessionTokenKeeper(s.client, "kobe.mcp-proxy", quiet);
    const egress = sessionTokenKeeper(s.client, "kobe.egress-proxy", quiet);
    const seen: string[] = [];
    mcp.onChange((t) => seen.push(t));
    egress.onChange((t) => seen.push(t));
    await Promise.all([mcp.start(), egress.start()]);
    expect(s.trades()).toBe(1);
    expect(s.client.rejected("kobe.sandbox-wire", "wire upgrade refused: HTTP 401")).toBe(true);
    await s.client.wireToken();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.trades()).toBe(2);
    expect(await mcp.current()).toBe(tok("mcp", 2));
    expect(await egress.current()).toBe(tok("egress", 2));
    expect(seen).toEqual([tok("mcp", 1), tok("egress", 1), tok("mcp", 2), tok("egress", 2)]);
    mcp.stop();
    egress.stop();
  });
});
