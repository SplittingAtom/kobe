import { afterEach, describe, expect, it } from "vitest";
import {
  APP_CARD_CUSTOM_TYPE,
  appCardContent,
  appCardEntryId,
  type AppCardEntry,
  type SandboxToServerFrame,
} from "@kobe/protocol";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";
import { RUN, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * KOBE-440 (spec MA11 "verify in the ticket") against the real pinned Pi 1.0.0: an app card is a
 * `custom_message` entry the agent appends to the session before the run, and Pi gives its
 * content to the model as a user message, before the member's prompt. The scripted model echoes
 * every user message it was given. A new thread whose first entry is the card starts its session
 * from the card.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

const SEED = "11111111-1111-4111-8111-111111111111";

function card(content: string): AppCardEntry {
  return {
    type: "custom_message",
    id: appCardEntryId(SEED),
    parentId: null,
    timestamp: "2026-10-19T10:00:00.000Z",
    customType: APP_CARD_CUSTOM_TYPE,
    content,
    display: true,
    details: {
      connector_id: SEED,
      app_id: "a".repeat(64),
      tool: "open_explorer",
      template_sha256: "a".repeat(64),
      result_ref: SEED,
      opened_by: SEED,
    },
  };
}

describe.skipIf(!PI_AVAILABLE)("app cards in real Pi 1.0.0 (KOBE-440)", () => {
  it("gives the model the card's text before the prompt; details stay out", async () => {
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
    });
    const harness = h;
    const content = appCardContent({
      connectorName: "Catalyst",
      tool: "open_explorer",
      text: "3 namespaces: a, b, c",
    });
    const only = card(content);
    const prompt = fauxScript([{ echoUsers: true }]);
    const started = await harness.server.command(
      runStart(prompt, { parent_entry_id: only.id, app_cards: [only] }),
      30_000,
    );
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    await until(
      () =>
        (harness.server.frames("pi.event") as PiEventFrame[]).some(
          (f) => f.run_id === RUN && f.event.type === "agent_settled",
        ),
      30_000,
    );
    const echoed = (harness.server.frames("pi.event") as PiEventFrame[]).flatMap((f) => {
      const ev = f.event as { type?: string; message?: { role?: string; content?: unknown } };
      if (f.run_id !== RUN || ev.type !== "message_end" || ev.message?.role !== "assistant") {
        return [];
      }
      const blocks = ev.message.content as { text?: string }[] | undefined;
      return (blocks ?? []).map((b) => b.text ?? "");
    });
    const users = echoed.find((t) => t.startsWith("USERS:")) ?? "";
    expect(JSON.parse(users.slice("USERS:".length))).toEqual([content, prompt]);
    expect(users).not.toContain("result_ref");

    // Pi kept the card in its session under the server's id, the prompt below it.
    const entries = (await harness.server.command(
      { type: "pi.command", thread_id: THREAD, command: { id: "srv", type: "get_entries" } },
      30_000,
    )) as { ok: boolean; data?: { entries: { id: string; parentId: string | null }[] } };
    const ids = entries.data?.entries.map((e) => e.id) ?? [];
    expect(ids[0]).toBe(only.id);
  }, 90_000);
});
