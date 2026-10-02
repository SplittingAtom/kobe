import { hostname } from "node:os";
import { count, eq, installRoles, SYSTEM_ACTOR, type KobeDb } from "@kobe/db";
import type { IsolationStatus } from "../isolation/gate.js";
import { recordAuditAfter } from "./record.js";

type State = IsolationStatus["state"];

/**
 * Audits this server replica's isolation state changes (spec D4; KOBE-15) as system events:
 * isolation lost or restored, or missing at startup. The normal boot (checking → verified) is not
 * recorded, or every rollout would add one row per replica. Nothing is recorded before first-run
 * setup: a fresh install that is about to be restored must stay empty (`kobe restore` refuses a
 * database with data).
 */
export function isolationAuditor(
  db: KobeDb,
  replica: string = hostname(),
): (status: IsolationStatus) => Promise<void> {
  let previous: State = "checking";
  return async (status) => {
    const from = previous;
    previous = status.state;
    if (from === status.state || (from === "checking" && status.state === "verified")) return;
    const [owners] = await db
      .select({ n: count() })
      .from(installRoles)
      .where(eq(installRoles.role, "owner"))
      .catch(() => [{ n: 1 }]);
    if ((owners?.n ?? 0) === 0) return;
    await recordAuditAfter(db, {
      action: "platform.isolation.changed",
      actor: SYSTEM_ACTOR,
      target: {
        from,
        to: status.state,
        replica: replica.slice(0, 253),
        ...(status.runtimeClassName ? { runtimeClass: status.runtimeClassName } : {}),
        ...(status.state === "verified" ? { handler: status.handler } : {}),
      },
    });
  };
}
