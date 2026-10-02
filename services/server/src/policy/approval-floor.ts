import { approvalModeSchema, type ApprovalMode } from "@kobe/protocol";
import { eq, installSettings, type KobeTx } from "@kobe/db";

/**
 * The install's minimum approval mode (spec D6 "policy floor: … minimum approval mode", D19
 * "approval mode can only be stricter than the floor", D29 modes). Stored in `install_settings`
 * under {@link APPROVAL_FLOOR_KEY}; no admin route writes it yet (the install policy console
 * does, later), so a fresh install has no floor beyond the engine's own rules: `auto` (which is
 * allow-listed only, never a bypass).
 *
 * Strictness: `auto` < `ask-on-write` < `ask-all`. `auto` is the loosest because it lifts the
 * prompt for allow-listed tools; everything else it denies.
 */
export const APPROVAL_FLOOR_KEY = "policy.approval_floor";

/** No configured floor: any mode the agent asks for. */
export const DEFAULT_APPROVAL_FLOOR: ApprovalMode = "auto";

/** The strictest mode, used when a stored floor can't be read (fail closed). */
export const STRICTEST_APPROVAL_MODE: ApprovalMode = "ask-all";

const RANK: Readonly<Record<ApprovalMode, number>> = { auto: 0, "ask-on-write": 1, "ask-all": 2 };

/** The strictest of `modes` (at least one). */
export function strictestApprovalMode(first: ApprovalMode, ...rest: ApprovalMode[]): ApprovalMode {
  return rest.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), first);
}

/** A stored floor value; anything unreadable is the strictest mode. */
export function parseApprovalFloor(value: string | undefined): ApprovalMode {
  if (value === undefined) return DEFAULT_APPROVAL_FLOOR;
  const parsed = approvalModeSchema.safeParse(value);
  return parsed.success ? parsed.data : STRICTEST_APPROVAL_MODE;
}

/** Reads the install's approval floor in `tx`. */
export async function readApprovalFloor(tx: KobeTx): Promise<ApprovalMode> {
  const [row] = await tx
    .select({ value: installSettings.value })
    .from(installSettings)
    .where(eq(installSettings.key, APPROVAL_FLOOR_KEY));
  return parseApprovalFloor(row?.value);
}
