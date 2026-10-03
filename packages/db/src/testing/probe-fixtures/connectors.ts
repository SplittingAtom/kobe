import { randomUUID } from "node:crypto";
import { connectors, teamConnectors, users } from "../../schema/index.js";
import type { connectors as connectorsDomain } from "../../tenancy/connectors.js";
import type { ProbeFixture } from "./types.js";

export const connectorsFixtures: Record<(typeof connectorsDomain.team)[number], ProbeFixture> = {
  team_connectors: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    const [connector] = await tx
      .insert(connectors)
      .values({ name: `probe-${randomUUID().slice(0, 8)}`, url: "https://mcp.probe.test/mcp" })
      .returning({ id: connectors.id });
    if (!connector) throw new Error("probe: connector insert returned nothing");
    await tx
      .insert(teamConnectors)
      .values({ teamId, connectorId: connector.id, exposure: "all", enabledBy: userId });
  },
};
