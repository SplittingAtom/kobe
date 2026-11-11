import type { PolicyDecision, ToolDescriptor } from "@kobe/protocol";
import { withTeam, type KobeDb } from "@kobe/db";
import {
  isKobeAdminTool,
  KOBE_ADMIN_NOT_ALLOWED_REASON,
  kobeToolName,
} from "../policy/kobe-admin-guard.js";
import { loadKobeAccess, personAllows, switchesAllow } from "./access.js";
import { kobeToolByName } from "./tools/index.js";

/**
 * The person half of a Kobe admin decision (KOBE-619, §8 "a tool hidden from tools/list is refused
 * on call too"): the run's user must hold the tool's console permission and the site and team
 * switches must allow it, re-read now. Used by the sandbox's `policy.check`, so a member is never
 * asked to approve a change their role cannot make; the MCP proxy's re-check does the same in
 * `kobe-mcp/service.ts`. Any failure is a deny.
 */
export async function kobeToolAllowedFor(
  db: KobeDb,
  teamId: string,
  userId: string,
  piName: string,
): Promise<boolean> {
  const tool = kobeToolOf(piName);
  if (tool === undefined) return false;
  const access = await withTeam(db, teamId, (tx) => loadKobeAccess(tx, teamId, userId));
  return switchesAllow(tool, access) && personAllows(tool, access);
}

function kobeToolOf(piName: string) {
  const name = kobeToolName(piName);
  return name === undefined ? undefined : kobeToolByName(name);
}

export async function guardKobeAdminCall(
  db: KobeDb,
  who: { readonly teamId: string; readonly userId: string },
  decision: PolicyDecision,
  tool: ToolDescriptor,
  /** The call's input as the sandbox sent it: checked against the tool's strict schema. */
  input: unknown,
): Promise<PolicyDecision> {
  // The docs tools (KOBE-620) need no permission: the ordinary policy decided them.
  if (!isKobeAdminTool(tool) || decision.effect === "deny") return decision;
  // A malformed call is refused before anyone is asked to approve it (review L4).
  const def = kobeToolOf(tool.name);
  if (def !== undefined && !def.input.safeParse(input ?? {}).success) {
    return {
      effect: "deny",
      risk: decision.risk,
      reasons: [
        {
          code: "invalid_input",
          stage: "site_deny",
          message: `The input of ${tool.name} is not valid, so the call was denied.`,
        },
      ],
    };
  }
  const allowed = await kobeToolAllowedFor(db, who.teamId, who.userId, tool.name).catch(
    () => false,
  );
  if (allowed) return decision;
  return {
    effect: "deny",
    risk: decision.risk,
    reasons: [
      {
        code: KOBE_ADMIN_NOT_ALLOWED_REASON,
        stage: "team_deny",
        message: `${tool.name} is not available to you in this team (your role, or the Kobe admin switches); it was denied.`,
      },
    ],
  };
}
