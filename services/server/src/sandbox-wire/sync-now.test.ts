import { describe, expect, it } from "vitest";
import { decodeBusHint, encodeBusHint, type BusHint } from "./bus.js";
import { SyncNowRequests } from "./sync-now.js";

const TEAM = "1a2b3c4d-1111-4222-8333-944455556666";
const USER = "2b3c4d5e-2222-4333-8444-a55566667777";
const CONN = "3c4d5e6f-3333-4444-8555-b66677778888";
const owner = { teamId: TEAM, userId: USER };

function harness(connection: string | undefined) {
  const sent: BusHint[] = [];
  let failNotify = false;
  const requests = new SyncNowRequests(
    () => Promise.resolve(connection),
    (hint) => {
      if (failNotify) return Promise.reject(new Error("bus down"));
      sent.push(hint);
      return Promise.resolve();
    },
  );
  return {
    requests,
    sent,
    failNextNotify: () => (failNotify = true),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sync now requests (KOBE-599)", () => {
  it("answers asleep without a live connection and sends nothing", async () => {
    const h = harness(undefined);
    await expect(h.requests.request(owner, 1000)).resolves.toBe("asleep");
    expect(h.sent).toEqual([]);
  });

  it("hints the holder with the connection and a fresh request id, and resolves on its answer", async () => {
    const h = harness(CONN);
    const answer = h.requests.request(owner, 5000);
    await tick();
    const hint = h.sent[0];
    expect(hint).toMatchObject({ kind: "sync", id: CONN });
    if (hint?.kind !== "sync") throw new Error("no sync hint");
    // Someone else's answer changes nothing.
    h.requests.answered("4d5e6f70-4444-4555-8666-c77788889999", true);
    expect(h.requests.waiting).toBe(1);
    h.requests.answered(hint.request, true);
    await expect(answer).resolves.toBe("synced");
    expect(h.requests.waiting).toBe(0);
  });

  it("reports not_synced, timeout, and a failed hint as not_synced", async () => {
    const h = harness(CONN);
    const no = h.requests.request(owner, 5000);
    await tick();
    const hint = h.sent[0];
    if (hint?.kind !== "sync") throw new Error("no sync hint");
    h.requests.answered(hint.request, false);
    await expect(no).resolves.toBe("not_synced");

    await expect(h.requests.request(owner, 20)).resolves.toBe("timeout");
    expect(h.requests.waiting).toBe(0);

    h.failNextNotify();
    await expect(h.requests.request(owner, 5000)).resolves.toBe("not_synced");
  });

  it("lets every waiter list on close", async () => {
    const h = harness(CONN);
    const answer = h.requests.request(owner, 60_000);
    await tick();
    h.requests.close();
    await expect(answer).resolves.toBe("not_synced");
  });

  it("round-trips the two-id sync hint and the answers on the bus, refusing malformed ones", () => {
    const req = "5e6f7081-5555-4666-8777-d88899990000";
    const sync: BusHint = { kind: "sync", id: CONN, request: req };
    expect(encodeBusHint(sync)).toBe(`sync:${CONN}:${req}`);
    expect(decodeBusHint(encodeBusHint(sync))).toEqual(sync);
    expect(decodeBusHint(`synced:${req}`)).toEqual({ kind: "synced", id: req });
    expect(decodeBusHint(`unsynced:${req}`)).toEqual({ kind: "unsynced", id: req });
    expect(decodeBusHint(`sync:${CONN}`)).toBeUndefined();
    expect(decodeBusHint(`sync:${CONN}:${req}:x`)).toBeUndefined();
    expect(decodeBusHint(`sync:${CONN}:not-a-uuid`)).toBeUndefined();
    expect(decodeBusHint(`synced:${req}${"x".repeat(40)}`)).toBeUndefined();
    expect(decodeBusHint(`mv:${CONN}`)).toEqual({ kind: "mv", id: CONN });
  });
});
