/** Invitation and password-reset client helpers (KOBE-13). The server stays authoritative. */

export type TeamRole = "team_admin" | "builder" | "member";

export interface PendingTeamInvite {
  readonly teamId: string;
  readonly teamSlug: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly invitedByName: string;
  readonly expiresAt: string;
}

/**
 * Reads `token` from a URL fragment (`#token=…`). Links carry tokens in the fragment so they never
 * reach a server or proxy log.
 */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

/** Mirrors the server's password rules. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < 12) return "Use at least 12 characters for the password.";
  if (password.length > 128) return "Use at most 128 characters for the password.";
  if (password !== confirm) return "The passwords don't match.";
  return null;
}

/** The signed-in user's open team invitations; empty when signed out. */
export async function fetchMyInvites(
  fetchFn: typeof fetch = fetch,
): Promise<readonly PendingTeamInvite[]> {
  const res = await fetchFn("/v1/me/invites");
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Could not load your invitations (HTTP ${res.status}).`);
  return ((await res.json()) as { invitations: PendingTeamInvite[] }).invitations;
}

export async function answerInvite(
  teamId: string,
  answer: "accept" | "decline",
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`/v1/me/invites/${encodeURIComponent(teamId)}/${answer}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("That invitation is no longer open.");
}
