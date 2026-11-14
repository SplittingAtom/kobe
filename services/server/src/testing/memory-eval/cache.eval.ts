import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TERMINAL_EVENT_TYPES } from "@kobe/protocol";
import { cacheShares, formatCacheShare, runUsageSchema } from "./score.js";

/**
 * `e2e/memory-eval.sh cache` (KOBE-387): replays e2e/fixtures/memory-cache/turns.json in one new
 * thread on a running Kobe through its public API, as a member would, and reports the cache-read
 * share from the gateway's usage records (`GET /v1/threads/{id}/usage`, the same `run_usage` rows
 * the docs/gates/gate-7a.md SQL reads). Gate A runs it once on the KOBE-382 build ("before") and
 * once on the KOBE-383 build ("after"). Everything comes from the environment (e2e/memory-eval.sh
 * lists it); nothing about an install is committed.
 */
const env = z
  .object({
    KOBE_EVAL_URL: z.url(),
    KOBE_EVAL_EMAIL: z.string().optional(),
    KOBE_EVAL_PASSWORD: z.string().optional(),
    KOBE_EVAL_COOKIE: z.string().optional(),
    KOBE_EVAL_TEAM_ID: z.uuid().optional(),
    KOBE_EVAL_AGENT_ID: z.uuid().optional(),
    KOBE_EVAL_MODEL: z.string().optional(),
    KOBE_EVAL_SEED: z.enum(["0", "1"]).optional(),
    KOBE_EVAL_LABEL: z.string().optional(),
    KOBE_EVAL_OUT: z.string().optional(),
    /** Per-turn limit in seconds (default 300). */
    KOBE_EVAL_TURN_TIMEOUT_S: z.coerce.number().int().positive().optional(),
  })
  .parse(process.env);

const FIXTURES = new URL("../../../../../e2e/fixtures/memory-cache/", import.meta.url);
const read = (f: string): unknown => JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8"));
const turns = z
  .object({ turns: z.array(z.string().min(1)).length(20) })
  .parse(read("turns.json")).turns;
const seed = z
  .object({ items: z.array(z.record(z.string(), z.unknown())).min(1) })
  .parse(read("seed.json")).items;

const say = (text: string) => writeSync(1, `${text}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = env.KOBE_EVAL_URL.replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const TERMINAL = new Set<string>(TERMINAL_EVENT_TYPES);
const USAGE_WAIT_MS = 60_000;

/** A cookie-jar client of the public API (the browser's headers: Origin for the CSRF check). */
function client() {
  const jar = new Map<string, string>();
  for (const pair of (env.KOBE_EVAL_COOKIE ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const team = env.KOBE_EVAL_TEAM_ID;
  const headers = (extra: Record<string, string> = {}) => ({
    origin: ORIGIN,
    "content-type": "application/json",
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    ...(team ? { "x-kobe-team": team } : {}),
    ...extra,
  });
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const self = {
    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(BASE + path, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      keep(res);
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      return { status: res.status, json, text };
    },
    /** Reads the run's event stream until a terminal event (or the deadline). */
    async waitForRun(runId: string, timeoutMs: number): Promise<string> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE}/v1/runs/${runId}/events`, {
          headers: headers({ accept: "text/event-stream" }),
          signal: abort.signal,
        });
        if (res.status !== 200 || !res.body) return `stream ${res.status}`;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = /^event: ?(.*)$/m.exec(block)?.[1];
            if (event && TERMINAL.has(event)) return event;
          }
        }
        return "stream ended";
      } catch (err) {
        return abort.signal.aborted ? "timeout" : String(err);
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    },
    async signIn() {
      if (env.KOBE_EVAL_EMAIL && env.KOBE_EVAL_PASSWORD) {
        const r = await self.call("POST", "/api/auth/sign-in/email", {
          email: env.KOBE_EVAL_EMAIL,
          password: env.KOBE_EVAL_PASSWORD,
        });
        if (r.status !== 200)
          throw new Error(`sign-in failed: ${r.status} ${r.text.slice(0, 200)}`);
      }
      if (team) {
        const r = await self.call("PUT", "/v1/me/teams/active", { teamId: team });
        if (r.status >= 300) throw new Error(`could not switch to the Workspace: ${r.status}`);
      }
    },
  };
  return self;
}

describe("memory cache-read replay (KOBE-387)", () => {
  it("replays 20 turns and reports the cache-read share", async () => {
    const c = client();
    await c.signIn();
    if (env.KOBE_EVAL_SEED === "1") {
      for (const item of seed) {
        const body = item.scope === "portable" ? { ...item, confirm_portable: true } : item;
        const r = await c.call("POST", "/v1/memory/semantic/items", body);
        say(
          `seed ${String(item.scope)}/${String(item.kind)}: ${r.status} ${String(r.json.code ?? "")}`,
        );
      }
    }
    const made = await c.call("POST", "/v1/threads", {
      title: `memory cache replay ${env.KOBE_EVAL_LABEL ?? ""}`.trim(),
      ...(env.KOBE_EVAL_AGENT_ID ? { agent_id: env.KOBE_EVAL_AGENT_ID } : {}),
      ...(env.KOBE_EVAL_MODEL ? { model: env.KOBE_EVAL_MODEL } : {}),
    });
    const threadId = made.json.thread_id;
    if (typeof threadId !== "string") {
      throw new Error(`could not create the thread: ${made.status} ${made.text.slice(0, 200)}`);
    }
    say(`thread ${threadId}`);
    const runIds: string[] = [];
    const timeoutMs = (env.KOBE_EVAL_TURN_TIMEOUT_S ?? 300) * 1000;
    for (const [i, content] of turns.entries()) {
      const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, { content });
      const runId = sent.json.run_id;
      if (sent.status !== 201 || typeof runId !== "string") {
        throw new Error(`turn ${i + 1}: message refused ${sent.status} ${sent.text.slice(0, 200)}`);
      }
      const end = await c.waitForRun(runId, timeoutMs);
      say(`turn ${i + 1}: run ${runId} ${end}`);
      if (end !== "run.completed") throw new Error(`turn ${i + 1} ended with ${end}`);
      runIds.push(runId);
    }
    // Usage is written by the gateway as calls finish; wait until every turn has a row.
    const deadline = Date.now() + USAGE_WAIT_MS;
    let shares;
    for (;;) {
      const r = await c.call("GET", `/v1/threads/${threadId}/usage`);
      if (r.status !== 200) throw new Error(`thread usage: ${r.status} ${r.text.slice(0, 200)}`);
      const usage = z.array(runUsageSchema).parse(r.json.runs);
      shares = cacheShares(usage, runIds);
      if (shares.missing.length === 0 || Date.now() > deadline) break;
      await sleep(2_000);
    }
    const label = env.KOBE_EVAL_LABEL ? ` (${env.KOBE_EVAL_LABEL})` : "";
    say(`\nKOBE-387 cache replay${label}: thread ${threadId}, ${runIds.length} turns`);
    say(formatCacheShare("all turns", shares.all));
    say(formatCacheShare("turns 2-20", shares.afterFirst));
    if (shares.missing.length > 0) say(`turns without usage: ${shares.missing.join(", ")}`);
    if (shares.all.cacheRead === 0) {
      say("no cache reads at all: does this model's provider report cached prompt tokens?");
    }
    if (env.KOBE_EVAL_OUT) {
      mkdirSync(dirname(env.KOBE_EVAL_OUT), { recursive: true });
      writeFileSync(
        env.KOBE_EVAL_OUT,
        JSON.stringify(
          { label: env.KOBE_EVAL_LABEL ?? null, threadId, runIds, ...shares },
          null,
          2,
        ),
      );
    }
    expect(runIds).toHaveLength(turns.length);
  });
});
