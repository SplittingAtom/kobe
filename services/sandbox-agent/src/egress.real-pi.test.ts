import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressWiring } from "./egress/egress-wiring.js";
import { THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-39 against the REAL pinned Pi 1.0.0: a bash tool call Pi runs gets the egress proxy with
 * the sandbox's current token from the agent's file, through the image's own BASH_ENV script —
 * the token is in no variable Pi was started with.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../images/sandbox/egress-env.sh",
);
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

describe.skipIf(!PI_AVAILABLE)("egress for tools with the real Pi (KOBE-39)", () => {
  it("a bash tool call Pi runs sees HTTPS_PROXY with the sandbox's current token", async () => {
    const egress: EgressWiring = {
      proxyUrl: "http://egress-proxy.kobe.internal:80",
      noProxy: "localhost",
      envScript: SCRIPT,
      tokens: { current: async () => TOKEN, onChange: () => () => undefined },
    };
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
      egress,
    });
    const harness = h;
    const command = 'printf "proxy=%s" "$HTTPS_PROXY"';
    const result = await harness.server.command(
      runStart(fauxScript([{ tool: "bash", id: "e1", args: { command } }])),
      30_000,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await until(() => harness.server.frames("policy.check").length > 0, 30_000);
    const check = harness.server.frames("policy.check")[0] as CheckFrame;
    harness.server.send({
      v: 1,
      type: "policy.result",
      request_id: check.request_id,
      run_id: check.run_id,
      tool_call_id: check.tool_call_id,
      decision: "allow",
      reasons: [{ code: "user_allow_rule", stage: "user_allow", message: "allowed" }],
    } as never);
    const events = () =>
      (harness.server.frames("pi.event") as PiEventFrame[]).map(
        (f) => f.event as Record<string, unknown>,
      );
    await until(
      () => events().some((e) => e.type === "tool_execution_end" && e.toolCallId === "e1"),
      30_000,
    );
    const end = events().find((e) => e.type === "tool_execution_end" && e.toolCallId === "e1") as {
      result: { content: { text: string }[] };
    };
    expect(end.result.content.map((c) => c.text).join("")).toContain(
      `proxy=http://${THREAD}:${TOKEN}@egress-proxy.kobe.internal:80`,
    );
  }, 60_000);
});
