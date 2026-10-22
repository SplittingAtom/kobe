import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunViewingContext, SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { VIEWING_HEADER } from "./memory/viewing-context.js";
import { THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  REAL_TOOLS_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-473 (spec FE7) against the REAL pinned Pi 1.0.0 with the real kobe-tools, through
 * kobe-sandbox-agent: the context only ever holds the current run's viewed file. A later run
 * carries its own file or none, Pi's session file never holds the fence or the file's text (nor
 * does any frame the server gets), and a restarted Pi rebuilt from that session brings nothing
 * of an older run back. The faux model answers with counts only (`countInSystem`), so neither
 * the prompt nor the needles reach the session through its reply.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;

const RUNS = [1, 2, 3, 4].map(
  (n) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
);
const ALPHA = "alpha-viewed-text-7f3a";
const BETA = "beta-viewed-text-91c2";
const FENCE = "<<<BEGIN VIEWED FILE";
const NEEDLES = [FENCE, VIEWING_HEADER, ALPHA, BETA] as const;

const viewed = (file: string, text: string): RunViewingContext => ({
  path: `notes/${file}`,
  sha256: "c".repeat(64),
  size: Buffer.byteLength(text),
  content: text,
  truncated: false,
});

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

const settled = (t: Harness, runId: string): boolean =>
  (t.server.frames("pi.event") as PiEventFrame[]).some(
    (f) => f.run_id === runId && (f.event as { type?: string }).type === "agent_settled",
  );

function countsOf(t: Harness, runId: string): number[] | undefined {
  for (const f of t.server.frames("pi.event") as PiEventFrame[]) {
    const event = f.event as { type?: string; message?: { role?: string; content?: unknown } };
    if (f.run_id !== runId || event.type !== "message_end") continue;
    if (event.message?.role !== "assistant" || !Array.isArray(event.message.content)) continue;
    const text = event.message.content.map((b: { text?: string }) => b.text ?? "").join("");
    if (text.startsWith("COUNTS:")) return JSON.parse(text.slice("COUNTS:".length)) as number[];
  }
  return undefined;
}

/** One run whose model reports how often each needle is in its system prompt. */
async function counts(t: Harness, runId: string, extra: Record<string, unknown> = {}) {
  const script = fauxScript([
    { countInSystem: NEEDLES.map((n) => Buffer.from(n).toString("base64")) },
  ]);
  const result = await t.server.command(runStart(script, { run_id: runId, ...extra }), 30_000);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await until(() => settled(t, runId), 30_000);
  const [fence, header, alpha, beta] = countsOf(t, runId) ?? [];
  return { fence, header, alpha, beta };
}

describe.skipIf(!PI_AVAILABLE)("only the current run's viewed file in real Pi (KOBE-473)", () => {
  it("a later run carries its own file or none; the session never holds it", async () => {
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
      toolsExtension: REAL_TOOLS_EXTENSION,
    });
    const t = h;
    const caps = (t.server.frames("hello")[0] as { capabilities?: string[] }).capabilities ?? [];
    expect(caps).toContain("file_edits");

    // Run 1 views a.md: one fence, one section, a.md's text.
    expect(await counts(t, RUNS[0] as string, { viewing: viewed("a.md", ALPHA) })).toEqual({
      fence: 1,
      header: 1,
      alpha: 1,
      beta: 0,
    });
    // Run 2 views b.md in the same Pi: only b.md, nothing of a.md.
    expect(await counts(t, RUNS[1] as string, { viewing: viewed("b.md", BETA) })).toEqual({
      fence: 1,
      header: 1,
      alpha: 0,
      beta: 1,
    });
    // Run 3 views nothing: no section at all.
    expect(await counts(t, RUNS[2] as string)).toEqual({ fence: 0, header: 0, alpha: 0, beta: 0 });

    // Pi's session file (what a restarted Pi rebuilds from) and every frame the server got.
    const session = await readFile(path.join(t.sessions, `${THREAD}.jsonl`), "utf8");
    const frames = JSON.stringify(t.server.received.map((r) => r.frame));
    for (const needle of [...NEEDLES, "VIEWED FILE", "a.md", "b.md"]) {
      expect(session).not.toContain(needle);
      expect(frames).not.toContain(needle);
    }

    // Another config restarts Pi (a new private runtime dir), which rebuilds the thread from that
    // session: nothing returns.
    const runtimeDirs = () => readdir(path.join(t.dir, "pi-runtime"));
    const before = await runtimeDirs();
    expect(
      await counts(t, RUNS[3] as string, { config: { system_prompt: "You are Kobe, restarted." } }),
    ).toEqual({ fence: 0, header: 0, alpha: 0, beta: 0 });
    const after = await runtimeDirs();
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((d) => before.includes(d))).toEqual([]);
    expect(JSON.stringify(t.server.received.map((r) => r.frame))).not.toContain(ALPHA);
  }, 120_000);
});
