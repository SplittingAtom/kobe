"use client";

import { useEffect, useState } from "react";
import { answerInvite, fetchMyInvites, type PendingTeamInvite } from "../lib/invites";
import { roleLabel } from "../lib/teams";

/** The user's open team invitations: nobody joins a team without accepting (KOBE-13). */
export function TeamInvites() {
  const [invites, setInvites] = useState<readonly PendingTeamInvite[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyInvites()
      .then(setInvites)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not load invitations."),
      );
  }, []);

  async function answer(teamId: string, choice: "accept" | "decline") {
    try {
      await answerInvite(teamId, choice);
      // Accepting changes the team list; reload so the switcher picks it up.
      if (choice === "accept") window.location.reload();
      else setInvites((all) => all.filter((i) => i.teamId !== teamId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not answer the invitation.");
    }
  }

  if (invites.length === 0 && !error) return null;
  return (
    <section aria-label="Team invitations">
      <h2>Team invitations</h2>
      <ul>
        {invites.map((i) => (
          <li key={i.teamId}>
            {i.invitedByName} invited you to <strong>{i.teamName}</strong> as {roleLabel(i.role)}.{" "}
            <button type="button" onClick={() => answer(i.teamId, "accept")}>
              Join
            </button>{" "}
            <button type="button" onClick={() => answer(i.teamId, "decline")}>
              Decline
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
