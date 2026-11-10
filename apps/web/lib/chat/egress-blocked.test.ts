import { describe, expect, it, vi } from "vitest";
import { blockedByPrompt, readThreadEgressBlocked } from "./egress-blocked";
import { MAX_ITEMS } from "./live";

const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";
const TS = "2026-11-10T10:00:00.000Z";

const row = (run: string, prompt: string | null, domain: string, seq = 1) => ({
  run_id: run,
  user_entry_id: prompt,
  seq,
  ts: TS,
  payload: { domain, request_access: true, reason: "not_in_ceiling" as const },
});

describe("blockedByPrompt (KOBE-605)", () => {
  it("groups by prompt entry as egress.blocked events, without the live run and promptless rows", () => {
    const map = blockedByPrompt(
      {
        blocked: [
          row(RUN_A, "u1", "example.org", 3),
          row(RUN_A, "u1", "example.org", 5),
          row(RUN_A, "u1", "pypi.org", 6),
          row(RUN_B, "u2", "example.org"),
          row(RUN_B, null, "orphan.org"),
        ],
      },
      undefined,
    );
    expect(map.get("u1")).toEqual([
      {
        type: "egress.blocked",
        run_id: RUN_A,
        seq: 3,
        ts: TS,
        payload: row(RUN_A, "u1", "example.org").payload,
      },
      {
        type: "egress.blocked",
        run_id: RUN_A,
        seq: 6,
        ts: TS,
        payload: row(RUN_A, "u1", "pypi.org").payload,
      },
    ]);
    expect(map.get("u2")?.map((n) => n.payload.domain)).toEqual(["example.org"]);
    expect([...map.keys()]).toEqual(["u1", "u2"]);

    const withoutLive = blockedByPrompt(
      { blocked: [row(RUN_A, "u1", "a.org"), row(RUN_B, "u2", "b.org")] },
      RUN_B,
    );
    expect([...withoutLive.keys()]).toEqual(["u1"]);
    expect(blockedByPrompt(null, undefined).size).toBe(0);
  });

  it("keeps the newest MAX_ITEMS per prompt", () => {
    const rows = Array.from({ length: MAX_ITEMS + 3 }, (_, i) =>
      row(RUN_A, "u1", `h${i}.org`, i + 1),
    );
    const list = blockedByPrompt({ blocked: rows }, undefined).get("u1") ?? [];
    expect(list).toHaveLength(MAX_ITEMS);
    expect(list[0]?.payload.domain).toBe("h3.org");
  });
});

describe("readThreadEgressBlocked", () => {
  it("reads the route with the team header and validates the body", async () => {
    const body = { blocked: [row(RUN_A, "u1", "example.org")] };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(await readThreadEgressBlocked("t 1", "team-1", fetchFn)).toEqual(body);
    expect(fetchFn).toHaveBeenCalledWith(
      "/v1/threads/t%201/egress-blocked",
      expect.objectContaining({ headers: expect.objectContaining({ "x-kobe-team": "team-1" }) }),
    );
    const bad = vi.fn(async () => new Response(JSON.stringify({ blocked: [{}] }), { status: 200 }));
    expect(await readThreadEgressBlocked("t", "team-1", bad)).toBeNull();
    const failed = vi.fn(async () => new Response("{}", { status: 500 }));
    expect(await readThreadEgressBlocked("t", "team-1", failed)).toBeNull();
  });
});
