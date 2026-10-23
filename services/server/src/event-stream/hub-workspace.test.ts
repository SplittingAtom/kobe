import { afterEach, describe, expect, it } from "vitest";
import { createRunEventHub, type RunEventHub } from "./hub.js";
import { decodeWorkspaceAccessHint, encodeWorkspaceAccessHint } from "./notify.js";

const USER = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";
const RUN = "1c7f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c12";
/** Nothing listens there: the hub stays down and polls (no database needed). */
const NOWHERE = "postgres://kobe:x@127.0.0.1:1/none";

let hub: RunEventHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

describe("run event hub: workspace change streams (KOBE-496 review)", () => {
  it("counts workspace stream slots apart from run stream slots", () => {
    hub = createRunEventHub({
      connectionString: NOWHERE,
      maxStreamsPerUser: 2,
      maxWorkspaceStreamsPerUser: 3,
    });
    const workspace = [1, 2, 3].map(() => hub?.acquireWorkspaceSlot(USER));
    expect(workspace.every((r) => typeof r === "function")).toBe(true);
    expect(hub.acquireWorkspaceSlot(USER)).toBeNull();
    // File tabs never use up the run streams' slots.
    expect(hub.acquireSlot(USER)).not.toBeNull();
    expect(hub.acquireSlot(USER)).not.toBeNull();
    expect(hub.acquireSlot(USER)).toBeNull();
    workspace[0]?.();
    workspace[0]?.(); // released once only
    expect(hub.acquireWorkspaceSlot(USER)).not.toBeNull();
    expect(hub.acquireWorkspaceSlot(USER)).toBeNull();
  });

  it("polls workspace streams much less often than run streams while LISTEN is down", async () => {
    hub = createRunEventHub({
      connectionString: NOWHERE,
      degradedPollMs: 20,
      workspaceDegradedPollMs: 400,
      reconnectMinMs: 60_000,
      reconnectMaxMs: 60_000,
      pingTimeoutMs: 200,
    });
    let runResyncs = 0;
    let workspaceResyncs = 0;
    let workspaceRechecks = 0;
    hub.subscribe(RUN, { hint: () => {}, resync: () => (runResyncs += 1), close: () => {} });
    hub.subscribeWorkspace(USER, {
      changed: () => {},
      resync: () => (workspaceResyncs += 1),
      revalidate: () => (workspaceRechecks += 1),
      close: () => {},
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(runResyncs).toBeGreaterThan(15);
    // The first tick, the lost connection's resync, then one per 400 ms at most.
    expect(workspaceResyncs).toBeLessThanOrEqual(5);
    expect(workspaceResyncs).toBeGreaterThan(0);
    // A missed removal hint is covered: every workspace resync rechecks the viewer too.
    expect(workspaceRechecks).toBe(workspaceResyncs);
  });

  it("encodes the workspace access hint with the user id only", () => {
    expect(encodeWorkspaceAccessHint(USER)).toBe(`wsa:${USER}`);
    expect(decodeWorkspaceAccessHint(`wsa:${USER}`)).toBe(USER);
    expect(decodeWorkspaceAccessHint(`ws:${USER}`)).toBeUndefined();
    expect(decodeWorkspaceAccessHint("wsa:nope")).toBeUndefined();
    expect(decodeWorkspaceAccessHint(undefined)).toBeUndefined();
  });
});
