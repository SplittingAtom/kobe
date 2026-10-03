import { eq, installToolRules, toolRules, type KobeTx } from "@kobe/db";
import { readApprovalFloor } from "../policy/approval-floor.js";
import { toPolicyRule } from "../policy/rule-store.js";
import type { PolicyRule } from "../policy/rules.js";
import type { PublishFloor } from "./manifest.js";

const compact = <T>(values: readonly (T | undefined)[]): T[] =>
  values.filter((v): v is T => v !== undefined);

/**
 * Reads the policy floor a version is published against, in the publishing transaction: the
 * install's deny/ask rules and approval floor, plus (for a team agent, `tx` inside the team's
 * `withTeam`) the team's own rules. User remember-rules never shape a manifest. Rows are read
 * through `toPolicyRule`, which fails closed on unreadable rows like the engine does.
 */
export async function readPublishFloor(
  tx: KobeTx,
  scope: PublishFloor["scope"],
): Promise<PublishFloor> {
  const install = await tx.select().from(installToolRules);
  const team: PolicyRule[] =
    scope === "team"
      ? compact(
          (await tx.select().from(toolRules).where(eq(toolRules.scope, "team"))).map((r) =>
            toPolicyRule(r, "team"),
          ),
        )
      : [];
  return {
    scope,
    install: compact(install.map((r) => toPolicyRule(r, "install"))),
    team,
    approvalFloor: await readApprovalFloor(tx),
  };
}
