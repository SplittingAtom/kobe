import { randomBytes } from "node:crypto";
import {
  eq,
  modelCatalog,
  modelProviders,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  SERVER_CALL_LIMITS,
  parseSkillEvalJudgeVerdict,
  skillEvalJudgeMessages,
  type SkillEvalJudgeOutput,
} from "@kobe/protocol";
import type { Logger } from "pino";
import { ServerCallError, type ServerCallClient } from "../../models/gateway-client.js";
import { resolveRunModel } from "../../runs/models.js";
import { JUDGE_BUDGET_CODES } from "./budget.js";
import type { EvalJudgeResult } from "./checks.js";

// The skill eval judge (KOBE-326, SK17; contract KOBE-324 `judge.ts`): one server-originated model
// call (KOBE-234, purpose `eval_judge`) per judged execution, after its run completed, on the judge
// model chosen at start (`judgeModelFor`), and only while the team still enables it: eval content
// never goes to a model the team has not enabled. The messages are the contract's: the rubric is
// the only instruction, everything the run produced is data between lines carrying a fresh
// 128-bit nonce, made here and never sent to the sandbox. No tools, no SKILL.md, no history;
// temperature 0 and the verdict's structured-output format where the provider is known to take
// it. The call has its own timeout (the runner keeps beating meanwhile). The gateway records the
// call in `run_usage` as kind `eval_judge` under the execution's member and run; its cost is read
// back from there, so the scorecard's judge spend is the ledger's.

/** Everything one judge call needs; the outputs were read from the sandbox before. */
export interface SkillEvalJudgeCall {
  readonly teamId: string;
  /** The eval's starter: the call's budget line and virtual key, as for the run. */
  readonly userId: string;
  readonly threadId: string;
  /** The execution's completed run (the gateway checks it and attributes the usage to it). */
  readonly runId: string;
  /** The judge model chosen at start. */
  readonly judgeAlias: string;
  readonly rubric: string;
  readonly prompt: string;
  readonly answer: string;
  readonly outputs: readonly SkillEvalJudgeOutput[];
}

export interface SkillEvalJudge {
  judge(call: SkillEvalJudgeCall): Promise<EvalJudgeResult>;
}

export interface SkillEvalJudgeOptions {
  readonly db: KobeDb;
  readonly client: ServerCallClient;
  readonly log: Pick<Logger, "info" | "warn">;
  /** The call's own timeout (default the purpose's `timeout_ms`). */
  readonly timeoutMs?: number;
  /** How long to wait for the gateway's ledger row after a reply (its writes are batched). */
  readonly costWaitMs?: number;
  readonly pollMs?: number;
}

/**
 * Provider kinds known to take the OpenAI `response_format: json_schema` through the gateway.
 * Elsewhere the judge relies on the instructions and the strict parser (one JSON object, alone or
 * in one fenced block): an unsupported field would fail every judgement on that provider.
 */
const STRUCTURED_OUTPUT_KINDS: ReadonlySet<string> = new Set(["openai"]);

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

type JudgeTarget =
  | {
      readonly ok: true;
      readonly model: string;
      readonly reasoning: boolean;
      readonly structured: boolean;
    }
  | { readonly ok: false };

/** The judge model's gateway id, if the team enables `alias` now (never a fallback). */
async function judgeTarget(tx: KobeTx, teamId: string, alias: string): Promise<JudgeTarget> {
  const resolved = await resolveRunModel(tx, teamId, alias);
  if (!resolved.ok || resolved.model === undefined) return { ok: false };
  const [row] = await tx
    .select({ kind: modelProviders.kind })
    .from(modelCatalog)
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
    .where(eq(modelCatalog.alias, alias));
  return {
    ok: true,
    model: resolved.model.gateway_model,
    reasoning: resolved.limits?.reasoning === true,
    structured: row !== undefined && STRUCTURED_OUTPUT_KINDS.has(row.kind),
  };
}

/** The run's judge spend in the ledger, and how many judge rows it has. */
async function judgeSpend(db: KobeDb, teamId: string, runId: string) {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ cost: string | number | null; n: string | number }>(sql`
      SELECT coalesce(sum(cost_usd), 0) AS cost, count(*) AS n FROM run_usage
       WHERE team_id = ${teamId} AND run_id = ${runId} AND kind = 'eval_judge'`);
    const row = res.rows[0];
    return { costUsd: Math.round(Number(row?.cost ?? 0) * 1e6) / 1e6, rows: Number(row?.n ?? 0) };
  });
}

const failed = (detail: string, costUsd = 0): EvalJudgeResult => ({
  kind: "failed",
  costUsd,
  detail,
});

/** The messages, or null when they cannot be made or sent (too large for the purpose). */
function messagesFor(call: SkillEvalJudgeCall) {
  let system: string;
  let user: string;
  try {
    ({ system, user } = skillEvalJudgeMessages({
      rubric: call.rubric,
      prompt: call.prompt,
      answer: call.answer,
      outputs: call.outputs,
      // Fresh per call, never stored or sent anywhere but in this call's user message.
      nonce: randomBytes(16).toString("hex"),
    }));
  } catch {
    return null;
  }
  const limits = SERVER_CALL_LIMITS.eval_judge;
  const fits =
    system.length <= limits.max_message_chars &&
    user.length <= limits.max_message_chars &&
    // The body escapes the messages once more; its own cap with room for the rest of it.
    Buffer.byteLength(JSON.stringify([system, user])) + 4096 <= limits.max_body_bytes;
  return fits
    ? ([
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ] as const)
    : null;
}

export function createSkillEvalJudge(options: SkillEvalJudgeOptions): SkillEvalJudge {
  const { db, client, log } = options;
  const timeoutMs = options.timeoutMs ?? SERVER_CALL_LIMITS.eval_judge.timeout_ms;
  const costWaitMs = options.costWaitMs ?? 10_000;
  const pollMs = options.pollMs ?? 200;

  /** The ledger's judge spend for the run; after a reply, waits for its row to land. */
  const costOf = async (call: SkillEvalJudgeCall, replied: boolean): Promise<number> => {
    const until = Date.now() + (replied ? costWaitMs : 0);
    for (;;) {
      const spend = await judgeSpend(db, call.teamId, call.runId);
      if (spend.rows > 0 || Date.now() >= until) return spend.costUsd;
      await delay(pollMs);
    }
  };

  return {
    async judge(call) {
      const target = await withTeam(db, call.teamId, (tx) =>
        judgeTarget(tx, call.teamId, call.judgeAlias),
      );
      if (!target.ok)
        return failed(`The judge model ${call.judgeAlias} is not enabled in this team.`);
      const messages = messagesFor(call);
      if (!messages) return failed("The answer and outputs could not be put to the judge.");
      let reply: string;
      try {
        reply = await client.complete({
          purpose: "eval_judge",
          teamId: call.teamId,
          userId: call.userId,
          threadId: call.threadId,
          runId: call.runId,
          model: target.model,
          reasoning: target.reasoning,
          messages: [...messages],
          structured: target.structured,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const code = err instanceof ServerCallError ? err.code : "internal";
        log.warn({ code, run_id: call.runId, model: target.model }, "skill eval judge call failed");
        const costUsd = await costOf(call, false);
        if (JUDGE_BUDGET_CODES.has(code))
          return {
            ...failed(`The judge call was refused (${code}).`, costUsd),
            budgetRefused: true,
          };
        return failed(`The judge call failed (${code}).`, costUsd);
      }
      const costUsd = await costOf(call, true);
      const outcome = parseSkillEvalJudgeVerdict(reply);
      if (!outcome.ok) return { kind: "unparseable", costUsd };
      return outcome.verdict.passed
        ? { kind: "passed", costUsd, reason: outcome.verdict.reason }
        : { kind: "rejected", costUsd, reason: outcome.verdict.reason };
    },
  };
}
