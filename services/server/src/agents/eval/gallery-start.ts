import { DEFAULT_EVAL_MAX_ASR, eq, teamMembers, teams, withTeam, type KobeDb } from "@kobe/db";
import type { BackgroundTasks } from "../../background.js";
import type { TeamRef } from "../../sandbox/manifests.js";
import { gatewayModelId, listOrbitModelOptions, pickOrbitModel } from "../orbit/model.js";
import { orbitMcpToolNames } from "../orbit/mcp-tools.js";
import { mapAgentVersionToOrbit, orbitExportToYaml } from "../orbit/orbit-export.js";
import type { AgentRecord } from "../store.js";
import { getVersion } from "../versions.js";
import type { EvalRunner } from "./service.js";
import { createEval, type EvalRecord } from "./store.js";

/**
 * An install admin runs the Orbit eval for a gallery agent's current version (KOBE-94). It runs in
 * `teamId`, a team the admin belongs to (the Job, namespace, gateway access and budget are that
 * team's), with the install default threshold. Nothing is published: the verdict becomes the
 * install-level score (`recordGalleryScore`).
 */

export type GalleryEvalOutcome =
  | { readonly ok: true; readonly eval: EvalRecord }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422 | 503;
      readonly code: string;
      readonly message: string;
    };

const refused = (status: 404 | 409 | 422 | 503, code: string, message: string) =>
  ({ ok: false, status, code, message }) as const;

export async function startGalleryEval(input: {
  readonly db: KobeDb;
  readonly runner: EvalRunner | undefined;
  readonly background: BackgroundTasks;
  readonly userId: string;
  readonly teamId: string;
  readonly agent: AgentRecord;
}): Promise<GalleryEvalOutcome> {
  const { db, agent, userId, runner } = input;
  if (!runner?.available) {
    return refused(503, "eval_unavailable", "Evals are not set up on this install.");
  }
  const [team] = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .where(eq(teams.id, input.teamId));
  const member = team
    ? await withTeam(db, team.id, async (tx) => {
        const rows = await tx
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(eq(teamMembers.userId, userId));
        return rows.length > 0;
      })
    : false;
  // One answer for "no such team" and "not your team": no probing of teams.
  if (!team || !member) {
    return refused(404, "team_not_found", "Pick a team you belong to to run the eval in.");
  }
  const version = agent.currentVersion;
  if (agent.archivedAt || version === null) {
    return refused(409, "agent_not_evaluable", "This gallery agent has no published version.");
  }
  const record = await getVersion(db, { scope: "gallery" }, agent.id, version);
  if (!record) return refused(409, "agent_not_evaluable", "The published version is missing.");

  const options = await listOrbitModelOptions(db, team.id);
  const model = pickOrbitModel(record.definition.frontmatter.model, options);
  if (!model) {
    return refused(
      409,
      "model_not_resolvable",
      "The agent's model is not enabled for that team (or it has no default model), so the eval can't run.",
    );
  }
  const mcpTools = await orbitMcpToolNames(
    db,
    team.id,
    record.toolManifest,
    record.definition.frontmatter.tools,
  );
  let yaml: string;
  try {
    yaml = orbitExportToYaml(
      mapAgentVersionToOrbit({
        definition: {
          ...record.definition,
          frontmatter: { ...record.definition.frontmatter, model: gatewayModelId(model) },
        },
        toolManifest: record.toolManifest,
        version,
        mcpTools,
      }),
    );
  } catch (err) {
    return refused(
      422,
      "orbit_export_invalid",
      err instanceof Error ? err.message : "This agent can't be exported for evaluation.",
    );
  }
  const created = await createEval(db, {
    teamId: team.id,
    agentId: agent.id,
    agentScope: "gallery",
    agentSlug: agent.slug,
    requestedBy: userId,
    draftRevision: record.draftRevision ?? agent.revision,
    definition: {
      frontmatter: record.definition.frontmatter,
      prompt: record.definition.prompt,
      galleryVersion: version,
    },
    model: gatewayModelId(model),
    toolManifest: record.toolManifest as unknown as Record<string, unknown>,
    threshold: DEFAULT_EVAL_MAX_ASR,
  });
  if (!created.ok) {
    return refused(409, "eval_in_progress", "An eval of this agent is already running.");
  }
  const ref: TeamRef = { id: team.id, slug: team.slug };
  const started = created.value;
  input.background.run(
    "orbit eval driver failed",
    () => runner.run({ record: started, team: ref, orbitYaml: yaml }),
    { evalId: started.id, teamId: team.id },
  );
  return { ok: true, eval: started };
}
