import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxToServerFrame } from "@kobe/protocol";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";
import {
  RUN,
  RUN_2,
  THREAD,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";

/**
 * KOBE-290 against the real pinned Pi: what Pi 1.0.0 keeps of a run stopped before its first
 * token, and what `get_entries since` hands the server afterwards. The server mirrors the prompt
 * as soon as Pi announces it (`message_end`, role user) and must never mirror it twice.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
interface Entry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly customType?: string;
  readonly message?: { readonly role?: string; readonly stopReason?: string; content?: unknown };
}
interface EntriesData {
  readonly entries: readonly Entry[];
  readonly leafId: string | null;
}

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

function events(harness: Harness, runId: string): { type?: string; message?: { role?: string } }[] {
  return (harness.server.frames("pi.event") as PiEventFrame[])
    .filter((f) => f.run_id === runId)
    .map((f) => f.event as { type?: string; message?: { role?: string } });
}

const settled = (harness: Harness, runId: string) =>
  events(harness, runId).some((e) => e.type === "agent_settled");

const roleOf = (e: Entry) => (e.type === "message" ? e.message?.role : e.type);

describe.skipIf(!PI_AVAILABLE)("Stop before Pi's first token in real Pi 1.0.0 (KOBE-290)", () => {
  it("keeps the prompt entry with its id; a later sync since it never returns it again", async () => {
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
    });
    const harness = h;
    const entries = async (since?: string): Promise<EntriesData> => {
      const res = (await harness.server.command(
        {
          type: "pi.command",
          thread_id: THREAD,
          command: { id: "srv", type: "get_entries", ...(since ? { since } : {}) },
        },
        30_000,
      )) as { ok: boolean; data?: EntriesData; error?: unknown };
      expect(res.ok, JSON.stringify(res)).toBe(true);
      return res.data ?? { entries: [], leafId: null };
    };

    const prompt = fauxScript([{ waitForAbort: true }]);
    const started = await harness.server.command(runStart(prompt), 30_000);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });

    // Pi announces the prompt (`message_end`, role user) before any model output: the server's
    // sync point. The entry is already in Pi's session at that moment.
    await until(
      () =>
        events(harness, RUN).some((e) => e.type === "message_end" && e.message?.role === "user"),
      30_000,
    );
    const atPrompt = await entries();
    const user = atPrompt.entries.find((e) => roleOf(e) === "user");
    expect(user, JSON.stringify(atPrompt)).toBeDefined();
    // The exact shapes the server accepts from an ended run (findRunPrompt, KOBE-290 review
    // M1/N2): Pi's setup entries carry these fields and no others. A new session also gets a
    // `system` message: Pi's own sections, the agent prompt as `addendum` (none here) and the
    // workspace as `cwd` (the server accepts it only with those predicted values).
    const setupKeys = Object.fromEntries(
      atPrompt.entries
        .filter((e) => e.type !== "message")
        .map((e) => [e.type, Object.keys(e).sort().join(",")]),
    );
    const system = atPrompt.entries.find((e) => e.message?.role === "system");
    expect(Object.keys(system ?? {}).sort()).toEqual([
      "id",
      "message",
      "parentId",
      "timestamp",
      "type",
    ]);
    const sm = system?.message as Record<string, unknown> | undefined;
    expect(Object.keys(sm ?? {}).sort()).toEqual([
      "content",
      "role",
      "sections",
      "timestamp",
      "toolsAdded",
    ]);
    expect(sm?.content).toBe("");
    const sections = sm?.sections as Record<string, string>;
    expect(Object.keys(sections).sort()).toEqual(["cwd", "docs", "preamble", "rules", "tools"]);
    expect(sections.cwd).toBe(`<cwd>\n${realpathSync(harness.workspace)}\n</cwd>`);
    expect(Buffer.byteLength(JSON.stringify(system), "utf8")).toBeLessThan(256 * 1024);
    expect(setupKeys).toEqual({
      model_change: "id,modelId,parentId,provider,timestamp,type",
      thinking_level_change: "id,parentId,thinkingLevel,timestamp,type",
    });
    expect(Object.keys(user ?? {}).sort()).toEqual([
      "id",
      "message",
      "parentId",
      "timestamp",
      "type",
    ]);
    expect(user?.message).toEqual({
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: expect.any(Number),
    });
    expect(atPrompt.leafId).toBe(user?.id);
    expect(events(harness, RUN).some((e) => e.type === "turn_end")).toBe(false);

    // Stop before the first token.
    const stopped = await harness.server.command(
      { type: "run.stop", run_id: RUN, thread_id: THREAD, mode: "abort", reason: "user_cancelled" },
      30_000,
    );
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true });
    await until(() => settled(harness, RUN), 30_000);

    // Pi keeps the prompt under the same id, and adds the aborted (empty) answer after it.
    const after = await entries();
    const afterRoles = after.entries.map(roleOf);
    expect(afterRoles.slice(-2)).toEqual(["user", "assistant"]);
    expect(after.entries.find((e) => e.id === user?.id)).toBeDefined();
    const aborted = after.entries.filter(
      (e) => roleOf(e) === "assistant" && e.message?.stopReason === "aborted",
    );
    expect(afterRoles.filter((r) => r === "user")).toHaveLength(1);
    expect(aborted.map((e) => e.parentId)).toEqual([user?.id]);

    // Today's cursor (the last entry mirrored before the run) re-sends the prompt with its id.
    const before = atPrompt.entries[atPrompt.entries.indexOf(user as Entry) - 1];
    const resync = await entries(before?.id);
    expect(resync.entries.filter((e) => roleOf(e) === "user").map((e) => e.id)).toEqual([user?.id]);

    // The next run continues from the prompt (Kobe's leaf once it is mirrored): the model gets
    // both prompts, and a sync since the prompt never returns it.
    const second = await harness.server.command(
      {
        ...runStart(fauxScript([{ echoUsers: true }]), { parent_entry_id: user?.id }),
        run_id: RUN_2,
      },
      30_000,
    );
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    await until(() => settled(harness, RUN_2), 30_000);
    const since = await entries(user?.id);
    expect(since.entries.some((e) => e.id === user?.id)).toBe(false);
    const sinceUsers = since.entries.filter((e) => roleOf(e) === "user");
    expect(sinceUsers).toHaveLength(1);
    // What comes back: the aborted answer (a sibling of the next run's branch marker), then the
    // next run's own entries.
    expect(since.entries[0]?.id).toBe(aborted[0]?.id);
    expect(since.entries.find((e) => e.customType === "kobe.branch")?.parentId).toBe(user?.id);
    const echoed = (harness.server.frames("pi.event") as PiEventFrame[]).flatMap((f) => {
      const ev = f.event as { type?: string; message?: { role?: string; content?: unknown } };
      if (f.run_id !== RUN_2 || ev.type !== "message_end" || ev.message?.role !== "assistant")
        return [];
      const content = ev.message.content as { text?: string }[] | undefined;
      return (content ?? []).map((b) => b.text ?? "");
    });
    const users = echoed.find((t) => t.startsWith("USERS:")) ?? "";
    expect(JSON.parse(users.slice("USERS:".length))).toEqual([
      prompt,
      fauxScript([{ echoUsers: true }]),
    ]);
  }, 90_000);
});
