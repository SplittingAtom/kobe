import type { KobeTx } from "../../client.js";

/** Inserts one row into a team table for `teamId` (inside a withTeam transaction). */
export type ProbeFixture = (tx: KobeTx, teamId: string) => Promise<void>;
