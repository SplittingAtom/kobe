import { describe, expect, it } from "vitest";
import {
  abortableSleep,
  createHoldRegistry,
  preferredWaitSeconds,
  tokenExpiryMs,
} from "./session-hold.js";
import type { UnassignedIdentity } from "./provider.js";

const POD: UnassignedIdentity = {
  state: "unassigned",
  namespace: "kobe-team-a",
  podName: "w-1",
  podUid: "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
  teamId: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
};

describe("preferredWaitSeconds", () => {
  it.each([
    ["wait=20", 20],
    ["respond-async, wait=5", 5],
    ["handling=lenient; wait=3", 3],
    ["WAIT=7", 7],
    [undefined, undefined],
    ["", undefined],
    ["wait=", undefined],
    ["wait=-1", undefined],
    ["nowait=4", undefined],
    ["wait=1234567", undefined],
  ])("%s → %s", (header, expected) => {
    expect(preferredWaitSeconds(header)).toBe(expected);
  });
});

describe("tokenExpiryMs", () => {
  const jwt = (payload: unknown) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  it("reads exp without verifying", () => {
    expect(tokenExpiryMs(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });
  it.each([["no-dots"], [jwt({ sub: "x" })], [jwt({ exp: "soon" })], ["h.!!!.s"]])(
    "is undefined for %s",
    (token) => {
      expect(tokenExpiryMs(token)).toBeUndefined();
    },
  );
});

describe("abortableSleep", () => {
  it("ends early when aborted", async () => {
    const c = new AbortController();
    const started = Date.now();
    const slept = abortableSleep(10_000, c.signal);
    c.abort();
    await slept;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it("returns at once when already aborted", async () => {
    await abortableSleep(10_000, AbortSignal.abort());
  });
});

describe("createHoldRegistry", () => {
  it("allows maxPerPod holds per pod, released once each", () => {
    const r = createHoldRegistry(1);
    const release = r.acquire(POD);
    expect(release).toBeDefined();
    expect(r.acquire(POD)).toBeUndefined();
    expect(r.acquire({ ...POD, podName: "w-2" })).toBeDefined();
    release?.();
    release?.();
    expect(r.acquire(POD)).toBeDefined();
    expect(r.acquire(POD)).toBeUndefined();
  });
});
