import { afterEach, describe, expect, it, vi } from "vitest";
import { browserThreadListSync, type ThreadListSync } from "./thread-list-sync";

/** CE19 (KOBE-220): a pin, archive or move in one tab reaches the team's other tabs only. */
const open: ThreadListSync[] = [];
const sync = (teamId: string) => {
  const s = browserThreadListSync(teamId);
  if (!s) throw new Error("BroadcastChannel is missing");
  open.push(s);
  return s;
};

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe("browserThreadListSync", () => {
  it("tells the same team's other tabs, never itself or another team", async () => {
    const here = sync("team-a");
    const there = sync("team-a");
    const otherTeam = sync("team-b");
    const own = vi.fn();
    const heard = vi.fn();
    const elsewhere = vi.fn();
    here.subscribe(own);
    there.subscribe(heard);
    otherTeam.subscribe(elsewhere);
    here.post("t-1");
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("t-1"));
    expect(own).not.toHaveBeenCalled();
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("ignores malformed messages and stops after close", async () => {
    const there = sync("team-c");
    const heard = vi.fn();
    there.subscribe(heard);
    const raw = new BroadcastChannel("kobe-threads:team-c");
    raw.postMessage({ threadId: 42 });
    raw.postMessage("t-2");
    raw.postMessage({ origin: "x", threadId: "t-3" });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("t-3"));
    expect(heard).toHaveBeenCalledTimes(1);
    there.close();
    raw.postMessage({ origin: "x", threadId: "t-4" });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toHaveBeenCalledTimes(1);
    raw.close();
  });
});
