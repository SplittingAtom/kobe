import { randomUUID } from "node:crypto";
import { connectorGrants, connectors, teamConnectors, users } from "../../schema/index.js";
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
  connector_grants: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    const [connector] = await tx
      .insert(connectors)
      .values({
        name: `probe-${randomUUID().slice(0, 8)}`,
        url: "https://mcp.probe.test/mcp",
        authKind: "api_key",
      })
      .returning({ id: connectors.id });
    if (!connector) throw new Error("probe: connector insert returned nothing");
    // Opaque envelope-shaped text: the probe never decrypts it.
    await tx.insert(connectorGrants).values({
      teamId,
      userId,
      connectorId: connector.id,
      sealed: "e1.probe.not-a-real-envelope",
      keyId: "probe",
      hint: "••••test",
    });
  },
};
