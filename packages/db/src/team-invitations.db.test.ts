import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { teamInvitations, teams, users } from "./schema/index.js";
import { listTeamInvitationsFor } from "./team-invitations.js";
import { withTeam } from "./with-team.js";

const app = createDb(inject("appUrl"), { max: 1 });
afterAll(() => app.close());

const inviter = randomUUID();
const [alpha, beta, gamma] = [randomUUID(), randomUUID(), randomUUID()];
const email = `${randomUUID()}@invitee.test`;
const later = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await app.db.insert(users).values({ id: inviter, name: "Inviter", email: `${inviter}@i.test` });
  await app.db.insert(teams).values([
    { id: alpha, slug: `alpha-${alpha.slice(0, 8)}`, name: "Alpha" },
    { id: beta, slug: `beta-${beta.slice(0, 8)}`, name: "Beta" },
    { id: gamma, slug: `gamma-${gamma.slice(0, 8)}`, name: "Gamma" },
  ]);
  const invite = (teamId: string, to: string, expiresAt: Date) =>
    withTeam(app.db, teamId, (tx) =>
      tx
        .insert(teamInvitations)
        .values({ teamId, email: to, role: "builder", invitedBy: inviter, expiresAt }),
    );
  await invite(alpha, email, later());
  await invite(beta, "someone-else@invitee.test", later());
  await invite(gamma, email, new Date(Date.now() - 1_000));
});

describe("listTeamInvitationsFor (team_invitations stays behind RLS)", () => {
  it("lists only open invitations addressed to the email, with team and inviter", async () => {
    const mine = await listTeamInvitationsFor(app.db, email.toUpperCase());
    expect(mine).toEqual([
      {
        id: expect.any(String),
        teamId: alpha,
        teamSlug: `alpha-${alpha.slice(0, 8)}`,
        teamName: "Alpha",
        role: "builder",
        invitedByName: "Inviter",
        expiresAt: expect.any(Date),
      },
    ]);
  });

  it("returns nothing for an address without invitations", async () => {
    expect(await listTeamInvitationsFor(app.db, "nobody@invitee.test")).toEqual([]);
  });

  it("leaves no team selected on the connection afterwards", async () => {
    await listTeamInvitationsFor(app.db, email);
    const seen = await app.db.select().from(teamInvitations);
    expect(seen).toEqual([]);
  });
});
