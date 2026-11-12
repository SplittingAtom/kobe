import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { delegationEnv, delegationOf, type Delegation } from "./delegation.js";

/** KOBE-619 §3: a delegation exists only as a minted value under a module-private symbol. */
const D: Delegation = {
  userId: "00000000-0000-4000-8000-000000000001",
  teamId: "00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000003",
  threadId: "00000000-0000-4000-8000-000000000004",
  toolCallId: "call_1",
};

const probe = () => {
  const app = new Hono();
  app.all("*", (c) => c.json({ delegation: delegationOf(c) ?? null }));
  return app;
};

const seen = async (env?: unknown, init?: RequestInit) =>
  ((await (await probe().request("/x", init, env as never)).json()) as { delegation: unknown })
    .delegation;

describe("delegation", () => {
  it("is read back from an env the executor minted, frozen", async () => {
    expect(await seen(delegationEnv(D))).toEqual(D);
    const env = delegationEnv(D);
    const value = Object.getOwnPropertySymbols(env).map((k) => env[k])[0] as Delegation;
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("is never read from headers, a body, a look-alike object or another symbol", async () => {
    const claim = JSON.stringify(D);
    expect(
      await seen(undefined, {
        method: "POST",
        headers: { "kobe-delegation": claim, "x-kobe-delegation": claim },
        body: claim,
      }),
    ).toBeNull();
    expect(await seen({ delegation: D })).toBeNull();
    expect(await seen({ [Symbol.for("kobe.delegation")]: D })).toBeNull();
    expect(await seen({ [Symbol("kobe.delegation")]: D })).toBeNull();
    // The real key with a value the module did not mint (e.g. a copy of a minted one).
    const env = delegationEnv(D);
    const [key] = Object.getOwnPropertySymbols(env);
    expect(await seen({ [key as symbol]: { ...D } })).toBeNull();
  });
});
