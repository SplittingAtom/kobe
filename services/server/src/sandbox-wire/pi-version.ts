import { PI_PINNED_VERSION, PI_PREVIOUS_MINORS } from "@kobe/protocol";

/** The minor (`1.4`) of a `major.minor.patch` version, or undefined when it is not one. */
function piMinor(version: string): string | undefined {
  return /^(\d+\.\d+)\.\d+$/.exec(version)?.[1];
}

/**
 * The pinned Pi's minor (`1.4.x`), or a previous minor named in `previousMinors` while a Pi
 * upgrade is rolling out (PI_PREVIOUS_MINORS, empty since KOBE-518); the server refuses anything
 * else with `unsupported_version` (contract).
 */
export function supportedPiVersion(
  version: string,
  previousMinors: readonly string[] = PI_PREVIOUS_MINORS,
): boolean {
  const minor = piMinor(version);
  return minor !== undefined && (minor === pinnedPiMinor() || previousMinors.includes(minor));
}

const pinnedPiMinor = (): string => PI_PINNED_VERSION.split(".").slice(0, 2).join(".");

/**
 * The hello's Pi gate: whether the version is supported, warning when it is supported only through
 * `previousMinors` (KOBE-511), so an upgrade's transition stays visible until the list is emptied
 * again (as KOBE-518 did for 1.0.x).
 */
export function admitPiVersion(
  version: string,
  log: { warn(obj: Record<string, unknown>, msg: string): void },
  sandboxId: string,
  previousMinors: readonly string[] = PI_PREVIOUS_MINORS,
): boolean {
  if (!supportedPiVersion(version, previousMinors)) return false;
  if (piMinor(version) !== pinnedPiMinor()) {
    log.warn(
      { sandbox_id: sandboxId, pi_version: version.slice(0, 32), pinned: PI_PINNED_VERSION },
      "sandbox runs a previous Pi minor (accepted while the upgrade rolls out; remove it from PI_PREVIOUS_MINORS once no such sandbox remains)",
    );
  }
  return true;
}
