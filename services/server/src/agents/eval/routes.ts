import type { Context, Hono } from "hono";
import { z } from "zod";
import type { KobeDb } from "@kobe/db";
import { forbidden, invalidRequest, notFound } from "../http.js";
import type { ResolvedAgent } from "../version-routes.js";
import { getEval, listAgentEvals, type EvalRecord } from "./store.js";

/** What the API says about an eval; the full report only on the detail endpoint. */
export function evalView(e: EvalRecord, withReport = false) {
  return {
    id: e.id,
    agentId: e.agentId,
    status: e.status,
    draftRevision: e.draftRevision,
    threshold: e.threshold,
    attackSuccessRate: e.attackSuccessRate,
    attempts: e.attempts,
    attackSuccesses: e.attackSuccesses,
    error: e.error,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
    startedAt: e.startedAt?.toISOString() ?? null,
    finishedAt: e.finishedAt?.toISOString() ?? null,
    ...(withReport ? { report: e.report } : {}),
  };
}

export interface EvalRouteOptions {
  readonly db: KobeDb;
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  readonly teamId: (c: Context) => string;
}

const LIST_LIMIT = 20;
const evalIdSchema = z.uuid();

/**
 * `GET /:id/evals` (newest first, plus the unfinished one if any: the UI polls it while a Publish
 * is "evaluating") and `GET /:id/evals/:evalId` (with the report). Visible to whoever may read
 * the agent's definition, in the team the evals ran in.
 */
export function mountEvalRoutes<E extends { Variables: object }>(
  app: Hono<E>,
  options: EvalRouteOptions,
): void {
  const { db } = options;
  app.get("/:id/evals", async (c) => {
    const found = await options.resolve(c);
    if (!found) return notFound(c);
    if (!found.access.readDefinition) return forbidden(c, "You can't read this agent's evals.");
    const evals = await listAgentEvals(db, options.teamId(c), found.agent.id, LIST_LIMIT);
    const active = evals.find((e) => e.status === "pending" || e.status === "running");
    return c.json({
      evals: evals.map((e) => evalView(e)),
      active: active ? evalView(active) : null,
    });
  });

  app.get("/:id/evals/:evalId", async (c) => {
    const found = await options.resolve(c);
    if (!found) return notFound(c);
    if (!found.access.readDefinition) return forbidden(c, "You can't read this agent's evals.");
    const id = evalIdSchema.safeParse(c.req.param("evalId"));
    if (!id.success) return invalidRequest(c, "The eval id must be a uuid.");
    const record = await getEval(db, options.teamId(c), id.data);
    if (!record || record.agentId !== found.agent.id) return notFound(c);
    return c.json({ eval: evalView(record, true) });
  });
}
