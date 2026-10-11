import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { THREAD, silentLogger, startHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-258: what the agent reports of a thread's session. Nothing before Pi has written the file
 * (Pi 1.0.0 keeps a new session's setup entries in memory only, and the next Pi makes other ones;
 * see session-continuity.real-pi.test.ts), and every refusal carries Pi's text into the log.
 */
let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

const getEntries = (harness: Harness, since?: string) =>
  harness.server.command({
    type: "pi.command",
    thread_id: THREAD,
    command: { id: "srv", type: "get_entries", ...(since === undefined ? {} : { since }) },
  });

describe("session entries (KOBE-258)", () => {
  it("reports no entries, and starts no Pi, before the session file exists", async () => {
    h = await startHarness();
    expect(await getEntries(h)).toMatchObject({ ok: true, data: { entries: [], leafId: null } });
    expect(existsSync(path.join(h.sessions, `${THREAD}.jsonl.commands.jsonl`))).toBe(false);
  });

  it("asks Pi once the file exists", async () => {
    h = await startHarness();
    await mkdir(h.sessions, { recursive: true });
    const entry = { type: "message", id: "u1", parentId: null, timestamp: "t", message: {} };
    await writeFile(
      path.join(h.sessions, `${THREAD}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: THREAD })}\n${JSON.stringify(entry)}\n`,
    );
    expect(await getEntries(h)).toMatchObject({
      ok: true,
      data: { entries: [{ id: "u1" }], leafId: "u1" },
    });
    expect(await h.commandsLog()).toContainEqual(expect.objectContaining({ type: "get_entries" }));
  });

  it("logs Pi's refusal text with the command", async () => {
    const logged: { obj: Record<string, unknown>; msg: string }[] = [];
    h = await startHarness({
      logger: {
        ...silentLogger,
        info: (obj: Record<string, unknown>, msg: string) => void logged.push({ obj, msg }),
      } as typeof silentLogger,
    });
    await mkdir(h.sessions, { recursive: true });
    await writeFile(path.join(h.sessions, `${THREAD}.jsonl`), "");
    const refused = await getEntries(h, "gone1234");
    expect(refused).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    expect(logged).toContainEqual({
      obj: expect.objectContaining({
        type: "pi.command",
        command: "get_entries",
        thread_id: THREAD,
        code: "pi_rejected",
        error: "Entry not found: gone1234",
      }),
      msg: "command refused",
    });
  });
});
