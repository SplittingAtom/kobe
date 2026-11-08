import { randomBytes } from "node:crypto";
import { and, eq, registryTags, withTeam, type KobeDb } from "@kobe/db";
import { MANIFEST_PATH, SERVER_CALL_LIMITS, type KobeSkillManifest } from "@kobe/protocol";
import type { Logger } from "pino";
import { ServerCallError, type ServerCallClient } from "../../models/gateway-client.js";
import { resolveRunModel } from "../../runs/models.js";
import { parseSkillMd } from "../skill-md.js";
import { manifestMessages } from "./prompt.js";
import { ManifestYamlError, manifestFromReply, manifestYaml } from "./parse.js";

/**
 * Drafts a version's `kobe.skill.yaml` with a model (KOBE-564): one server-originated call
 * (KOBE-234 contract, purpose `skill_manifest`, no run) on the model the member chose, which
 * must be enabled for the team (never a fallback to another model), under the member's own budget
 * lines. The reply is cleaned to the package contract (`parse.ts`); the name, version and
 * license are never the model's. The YAML is checked the way an upload would read it before it
 * is handed back, so a generated file is always one the package contract accepts.
 */

export const SKILL_MD_PATH = "SKILL.md";

export interface SkillManifestRequest {
  readonly teamId: string;
  /** The member asking: the call's budget line and virtual key. */
  readonly userId: string;
  /** The catalog alias the member chose; undefined: the team default. */
  readonly modelAlias?: string | undefined;
  readonly name: string;
  readonly semver: string;
  /** The version's files (the package: SKILL.md and the rest). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The author's license choice (SPDX expression or `Proprietary`); omitted: none yet. */
  readonly license?: string | undefined;
}

export type SkillManifestFailure =
  | "busy"
  | "invalid_skill_md"
  | "name_mismatch"
  | "model_not_enabled"
  | "no_model"
  | "too_large"
  | "call_failed"
  | "not_serialisable";

export type SkillManifestOutcome =
  | {
      readonly ok: true;
      readonly manifest: KobeSkillManifest;
      readonly yaml: Uint8Array;
      /** The model that answered (alias and gateway id). */
      readonly model: { readonly alias: string; readonly gatewayModel: string };
      /** `model`: fields from the reply; `seed`: the reply held nothing usable, SKILL.md alone. */
      readonly source: "model" | "seed";
    }
  | {
      readonly ok: false;
      readonly code: SkillManifestFailure;
      readonly message: string;
      /** The gateway's or client's short code (safe to log and show). */
      readonly detail?: string;
    };

export interface SkillManifestGenerator {
  generate(request: SkillManifestRequest): Promise<SkillManifestOutcome>;
}

export type ModelTarget =
  | {
      readonly ok: true;
      readonly alias: string;
      readonly gatewayModel: string;
      readonly reasoning: boolean;
    }
  | { readonly ok: false; readonly code: "model_not_enabled" | "no_model" };

export interface SkillManifestGeneratorOptions {
  readonly db: KobeDb;
  readonly client: ServerCallClient;
  readonly log: Pick<Logger, "info" | "warn">;
  /** The call's own timeout (default the purpose's `timeout_ms`). */
  readonly timeoutMs?: number;
  /** Seam for tests: the team's model for an alias (default `resolveRunModel`). */
  readonly resolveModel?: (teamId: string, alias: string | undefined) => Promise<ModelTarget>;
  /** Seam for tests: the Site's active topic tags (default `registry_tags`). */
  readonly knownTags?: () => Promise<readonly string[]>;
}

/** The alias's gateway model if the team enables it now; the team default without an alias. */
export async function resolveManifestModel(
  db: KobeDb,
  teamId: string,
  alias: string | undefined,
): Promise<ModelTarget> {
  return withTeam(db, teamId, async (tx) => {
    const resolved = await resolveRunModel(tx, teamId, alias);
    if (!resolved.ok) return { ok: false, code: "model_not_enabled" };
    if (resolved.model === undefined) return { ok: false, code: "no_model" };
    return {
      ok: true,
      alias: resolved.model.alias,
      gatewayModel: resolved.model.gateway_model,
      reasoning: resolved.limits?.reasoning === true,
    };
  });
}

/** The Site's active topic tags (never the system ones such as `default`). */
async function activeTopicTags(db: KobeDb): Promise<string[]> {
  const rows = await db
    .select({ name: registryTags.name })
    .from(registryTags)
    .where(and(eq(registryTags.status, "active"), eq(registryTags.kind, "topic")));
  return rows.map((r) => r.name).sort();
}

const fail = (
  code: SkillManifestFailure,
  message: string,
  detail?: string,
): SkillManifestOutcome => ({ ok: false, code, message, ...(detail ? { detail } : {}) });

export function createSkillManifestGenerator(
  options: SkillManifestGeneratorOptions,
): SkillManifestGenerator {
  const { db, client, log } = options;
  const timeoutMs = options.timeoutMs ?? SERVER_CALL_LIMITS.skill_manifest.timeout_ms;
  const resolveModel =
    options.resolveModel ?? ((teamId, alias) => resolveManifestModel(db, teamId, alias));
  const knownTags = options.knownTags ?? (() => activeTopicTags(db));

  // One call at a time per member on this replica (review M1): a manifest call may hold one of
  // the team's server-call slots for up to a minute, and titles and the eval judge share them.
  const inFlight = new Set<string>();

  return {
    async generate(request) {
      const key = `${request.teamId}:${request.userId}`;
      if (inFlight.has(key))
        return fail("busy", "A manifest is already being written for you; wait for it.");
      inFlight.add(key);
      try {
        return await generateOnce(request);
      } finally {
        inFlight.delete(key);
      }
    },
  };

  async function generateOnce(request: SkillManifestRequest): Promise<SkillManifestOutcome> {
    {
      const md = request.files.get(SKILL_MD_PATH);
      const parsed = md ? parseSkillMd(md) : "SKILL.md is missing.";
      if (typeof parsed === "string") return fail("invalid_skill_md", parsed);
      if (parsed.name !== request.name)
        return fail("name_mismatch", `SKILL.md names ${parsed.name}, not ${request.name}.`);
      const target = await resolveModel(request.teamId, request.modelAlias);
      if (!target.ok) {
        return target.code === "no_model"
          ? fail("no_model", "The team has no enabled model to write the manifest with.")
          : fail(
              "model_not_enabled",
              `The model ${request.modelAlias ?? ""} is not enabled in this team.`.replace(
                "  ",
                " ",
              ),
            );
      }
      const messages = manifestMessages({
        name: request.name,
        semver: request.semver,
        skillMd: new TextDecoder().decode(md),
        paths: [...request.files.keys()]
          .filter((p) => p !== SKILL_MD_PATH && p !== MANIFEST_PATH)
          .sort(),
        knownTags: await knownTags(),
        // Fresh per call, never stored or sent anywhere but in this call's user message.
        nonce: randomBytes(16).toString("hex"),
      });
      if (!messages) return fail("too_large", "The skill is too large to describe in one call.");
      let reply: string;
      try {
        reply = await client.complete({
          purpose: "skill_manifest",
          teamId: request.teamId,
          userId: request.userId,
          model: target.gatewayModel,
          reasoning: target.reasoning,
          messages,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const code = err instanceof ServerCallError ? err.code : "error";
        log.warn(
          { purpose: "skill_manifest", team_id: request.teamId, model: target.alias, code },
          "skill manifest call failed",
        );
        return fail(
          "call_failed",
          `The model ${target.alias} did not answer (${code.replaceAll("_", " ")}).`,
          code,
        );
      }
      const seed = {
        name: request.name,
        semver: request.semver,
        description: parsed.description,
        license: request.license,
      };
      const { manifest, fromModel } = manifestFromReply(reply, seed);
      if (!fromModel) {
        log.info(
          { purpose: "skill_manifest", team_id: request.teamId, model: target.alias },
          "skill manifest reply held no usable JSON; SKILL.md's description used",
        );
      }
      try {
        return {
          ok: true,
          manifest,
          yaml: manifestYaml(manifest),
          model: { alias: target.alias, gatewayModel: target.gatewayModel },
          source: fromModel ? "model" : "seed",
        };
      } catch (err) {
        if (!(err instanceof ManifestYamlError)) throw err;
        return fail("not_serialisable", err.message);
      }
    }
  }
}
