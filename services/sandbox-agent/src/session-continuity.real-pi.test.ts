import { existsSync } from "node:fs";
import path from "node:path";
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
 * KOBE-258 against the real pinned Pi: Pi 1.0.0 keeps a new session's setup entries (model,
 * thinking level) in memory until the first user message, then writes the file. Those entries
 * must never reach the server: the thread's next Pi (restarted for the run's config) makes new
 * ones with other ids, so `get_entries since <old id>` failed for good, the run's entries were
 * never mirrored, and the next run's restore from Postgres overwrote the real session.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
interface Entry {
  readonly id: string;
  readonly type: string;
  readonly message?: { readonly role?: string; readonly stopReason?: string };
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

function settled(harness: Harness, runId: string): boolean {
  return (harness.server.frames("pi.event") as PiEventFrame[]).some(
    (f) => f.run_id === runId && (f.event as { type?: string }).type === "agent_settled",
  );
}

function assistantTexts(harness: Harness, runId: string): string[] {
  return (harness.server.frames("pi.event") as PiEventFrame[]).flatMap((f) => {
    const event = f.event as { type?: string; message?: { role?: string; content?: unknown } };
    if (f.run_id !== runId || event.type !== "message_end") return [];
    if (event.message?.role !== "assistant" || !Array.isArray(event.message.content)) return [];
    return event.message.content.map((b: { text?: string }) => b.text ?? "");
  });
}

describe.skipIf(!PI_AVAILABLE)("session continuity in real Pi 1.0.0 (KOBE-258)", () => {
  it("keeps a turn cut off at the output limit, and the next run has its context", async () => {
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
    });
    const harness = h;
    const piCommand = async (command: Record<string, unknown>) =>
      harness.server.command(
        { type: "pi.command", thread_id: THREAD, command: { id: "srv", ...command } },
        30_000,
      ) as Promise<{ ok: boolean; data?: EntriesData; error?: { message: string } }>;

    // The server's first sync of a new thread: nothing is durable yet, so nothing is reported.
    const before = await piCommand({ type: "get_entries" });
    expect(before).toMatchObject({ ok: true, data: { entries: [], leafId: null } });

    // The run's config differs from a bare Pi's launch: before KOBE-258 this restarted Pi.
    const prompt = fauxScript([{ thinking: "<html>…", stopReason: "length" }]);
    const started = await harness.server.command(
      runStart(prompt, { config: { system_prompt: "You are Kobe." } }),
      30_000,
    );
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    await until(() => settled(harness, RUN), 30_000);

    const after = await piCommand({ type: "get_entries" });
    expect(after.ok, JSON.stringify(after)).toBe(true);
    const messages = (after.data?.entries ?? []).filter(
      (e) => e.type === "message" && e.message?.role !== "system",
    );
    expect(messages.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.message?.stopReason).toBe("length");
    expect(existsSync(path.join(harness.sessions, `${THREAD}.jsonl`))).toBe(true);
    const leaf = after.data?.leafId;
    expect(leaf).toBe(after.data?.entries.at(-1)?.id);

    // The next run (another config, so another Pi) resumes the same session.
    const second = await harness.server.command(
      {
        ...runStart(fauxScript([{ echoUsers: true }]), {
          config: { system_prompt: "You are Kobe, again." },
        }),
        run_id: RUN_2,
      },
      30_000,
    );
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    await until(() => settled(harness, RUN_2), 30_000);
    const echoed = assistantTexts(harness, RUN_2).find((t) => t.startsWith("USERS:")) ?? "";
    expect(JSON.parse(echoed.slice("USERS:".length))).toEqual([
      prompt,
      fauxScript([{ echoUsers: true }]),
    ]);
    const since = await piCommand({ type: "get_entries", since: leaf });
    expect(since, JSON.stringify(since)).toMatchObject({ ok: true });
  }, 60_000);
});
