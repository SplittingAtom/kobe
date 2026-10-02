import type { TeamTable } from "../../tenancy.js";
import { identityFixtures } from "./identity.js";
import type { ProbeFixture } from "./types.js";

/**
 * One row-inserting fixture per team table, used by the cross-team probe suite. Typed as a
 * Record over TeamTable so adding a team table without a fixture fails to compile. Each spec area
 * keeps its fixtures in its own file here (named after its `tenancy/` file) and spreads them in.
 */
export const PROBE_FIXTURES: Readonly<Record<TeamTable, ProbeFixture>> = {
  ...identityFixtures,
};
