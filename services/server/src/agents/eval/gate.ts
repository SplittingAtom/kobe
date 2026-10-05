import { validateAgentDefinition } from "@kobe/agent-file";
import { withTeam, type KobeDb } from "@kobe/db";
import type { BackgroundTasks } from "../../background.js";
import type { TeamRef } from "../../sandbox/manifests.js";
import { readPublishFloor } from "../floor.js";
import { computeToolManifest } from "../manifest.js";
import { gatewayModelId, listOrbitModelOptions, pickOrbitModel } from "../orbit/model.js";
import { mapAgentVersionToOrbit, orbitExportToYaml } from "../orbit/orbit-export.js";
import type { AgentLocation, AgentRecord } from "../store.js";
import { contentKey, getVersion, type PublishError } from "../versions.js";
import type { EvalRunner } from "./service.js";
import { createEval, readEvalSettings, type EvalRecord } from "./store.js";

/**
 * The pre-publish Orbit eval gate (KOBE-93, spec D19). When the team turned the gate on, Publish
 * does not publish: it freezes the draft, exports it as Orbit YAML and starts an eval Job, and
 * answers 202 with the eval. The version is created only when the eval passes (`EvalRunner`).
 * Gallery agents and rollbacks are not gated (a rollback republishes content that was gated when
 * it was first published).
 */

export type GateOutcome =
  | { readonly kind: "ungated" }
  | { readonly kind: "started"; readonly eval: EvalRecord }
  | { readonly kind: "publish_error"; readonly error: PublishError }
  | {
      readonly kind: "refused";
      readonly status: 409 | 422 | 503;
      readonly code: string;
      readonly message: string;
    };

export interface GateInput {
  readonly db: KobeDb;
  readonly runner: EvalRunner | undefined;
  readonly background: BackgroundTasks;
  readonly team: TeamRef;
  readonly userId: string;
  readonly agent: AgentRecord;
  readonly location: AgentLocation;
  /** The draft revision the publisher reviewed (If-Match); undefined publishes the current draft. */
  readonly expectedRevision: number | undefined;
}

export async function gatePublish(input: GateInput): Promise<GateOutcome> {
  const { db, agent, location } = input;
  if (location.scope === "gallery") return { kind: "ungated" };
  const settings = await readEvalSettings(db, input.team.id);
  if (!settings.enabled) return { kind: "ungated" };

  // Fail closed: an enabled gate never lets a publish through unevaluated.
  if (!input.runner?.available) {
    return refused(
      503,
      "eval_unavailable",
      "This team requires an Orbit eval before publishing, but evals are not set up on this install. " +
        "Ask an install admin; nothing was published.",
    );
  }
  if (agent.archivedAt) return { kind: "publish_error", error: "archived" };
  if (input.expectedRevision !== undefined && agent.revision !== input.expectedRevision) {
    return { kind: "publish_error", error: "revision_mismatch" };
  }
  const draft = validateAgentDefinition({ frontmatter: agent.frontmatter, prompt: agent.prompt });
  if (!draft.ok) return { kind: "publish_error", error: "invalid_draft" };

  const options = await listOrbitModelOptions(db, input.team.id);
  const model = pickOrbitModel(draft.definition.frontmatter.model, options);
  if (!model) {
    return refused(
      409,
      "model_not_resolvable",
      "The agent's model is not enabled for this team (or it pins none and there is no team " +
        "default), so the eval can't run. Nothing was published.",
    );
  }
  const floor = await withTeam(db, input.team.id, (tx) =>
    readPublishFloor(tx, location.scope === "team" ? "team" : "install"),
  );
  const toolManifest = computeToolManifest(draft.definition.frontmatter, floor, new Date());
  if (agent.currentVersion !== null) {
    const current = await getVersion(db, location, agent.id, agent.currentVersion).catch(
      () => null,
    );
    if (
      current &&
      contentKey(current.definition, current.toolManifest) ===
        contentKey(draft.definition, toolManifest)
    ) {
      return { kind: "publish_error", error: "unchanged" };
    }
  }
  let yaml: string;
  try {
    yaml = orbitExportToYaml(
      mapAgentVersionToOrbit({
        definition: {
          ...draft.definition,
          frontmatter: { ...draft.definition.frontmatter, model: gatewayModelId(model) },
        },
        toolManifest,
        version: (agent.currentVersion ?? 0) + 1,
      }),
    );
  } catch (err) {
    return refused(
      422,
      "orbit_export_invalid",
      err instanceof Error ? err.message : "This draft can't be exported for evaluation.",
    );
  }
  const created = await createEval(db, {
    teamId: input.team.id,
    agentId: agent.id,
    agentScope: location.scope,
    agentSlug: agent.slug,
    requestedBy: input.userId,
    draftRevision: agent.revision,
    definition: { frontmatter: draft.definition.frontmatter, prompt: draft.definition.prompt },
    model: gatewayModelId(model),
    threshold: settings.maxAttackSuccessRate,
  });
  if (!created.ok) {
    return refused(
      409,
      "eval_in_progress",
      "An eval of this agent is already running. Wait for its result before publishing again.",
    );
  }
  const record = created.value;
  const runner = input.runner;
  input.background.run(
    "orbit eval driver failed",
    () => runner.run({ record, team: input.team, orbitYaml: yaml }),
    { evalId: record.id, teamId: input.team.id },
  );
  return { kind: "started", eval: record };
}

const refused = (status: 409 | 422 | 503, code: string, message: string): GateOutcome => ({
  kind: "refused",
  status,
  code,
  message,
});
