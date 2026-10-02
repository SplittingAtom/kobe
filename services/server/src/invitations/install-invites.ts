import { accounts, and, asc, eq, gt, invitations, isNull, sql, users, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { hashToken, newToken, sameHash, TOKEN_PATTERN } from "./tokens.js";

/** Install invitations expire after 72 hours; a resend issues a new token and a new expiry. */
export const INVITE_TTL_HOURS = 72;

// Expiry is set and checked with the database clock, so replicas with skewed clocks agree.
const dbNow = sql`now()`;
const inviteExpiry = sql`now() + make_interval(hours => ${INVITE_TTL_HOURS})`;
const unexpired = () => gt(invitations.expiresAt, dbNow);

export interface InviteSummary {
  readonly id: string;
  readonly email: string;
  readonly invitedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired";
}

export interface IssuedInvite {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: Date;
  /** The plaintext token: goes into the email and nowhere else. */
  readonly token: string;
}

const open = () => and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function userExists(db: KobeDb, email: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return row !== undefined;
}

/**
 * Invites an address into the install, or re-issues the open invitation for it (new token, new
 * expiry: the old link stops working). Install admins see the user list, so "already a user" is
 * reported plainly here.
 */
export async function issueInvite(
  db: KobeDb,
  input: { readonly email: string; readonly invitedBy: string },
): Promise<IssuedInvite | "user_exists"> {
  const email = normalizeEmail(input.email);
  if (await userExists(db, email)) return "user_exists";
  const { token, hash } = newToken();
  const fresh = {
    tokenHash: hash,
    invitedBy: input.invitedBy,
    createdAt: dbNow,
    expiresAt: inviteExpiry,
  };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invitations)
      .values({ email, ...fresh })
      .onConflictDoUpdate({
        target: invitations.email,
        targetWhere: sql`${invitations.acceptedAt} IS NULL AND ${invitations.revokedAt} IS NULL`,
        set: fresh,
      })
      .returning({ id: invitations.id, expiresAt: invitations.expiresAt });
    if (!row) throw new Error("invitation upsert returned no row");
    await recordAudit(tx, {
      action: "identity.invitation.created",
      target: { invitationId: row.id, email },
    });
    return { id: row.id, email, expiresAt: row.expiresAt, token };
  });
}

/** Re-issues an open invitation by id (new token and expiry); null if it is accepted or revoked. */
export async function reissueInvite(
  db: KobeDb,
  id: string,
  invitedBy: string,
): Promise<IssuedInvite | null> {
  const { token, hash } = newToken();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(invitations)
      .set({ tokenHash: hash, invitedBy, createdAt: dbNow, expiresAt: inviteExpiry })
      .where(and(eq(invitations.id, id), open()))
      .returning({
        id: invitations.id,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
      });
    if (!row) return null;
    await recordAudit(tx, {
      action: "identity.invitation.resent",
      target: { invitationId: row.id, email: row.email },
    });
    return { ...row, token };
  });
}

/** The address of an open invitation, or null. */
export async function findOpenInviteEmail(db: KobeDb, id: string): Promise<string | null> {
  const [row] = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(and(eq(invitations.id, id), open()));
  return row?.email ?? null;
}

/** Revokes an open invitation; its link stops working at once. */
export async function revokeInvite(db: KobeDb, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(invitations)
      .set({ revokedAt: dbNow })
      .where(and(eq(invitations.id, id), open()))
      .returning({ id: invitations.id });
    if (rows.length === 0) return false;
    await recordAudit(tx, { action: "identity.invitation.revoked", target: { invitationId: id } });
    return true;
  });
}

/** Open invitations (pending or expired), oldest first. */
export async function listInvites(db: KobeDb): Promise<InviteSummary[]> {
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      invitedById: users.id,
      invitedByName: users.name,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      live: sql<boolean>`${invitations.expiresAt} > now()`,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.invitedBy))
    .where(open())
    .orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    invitedBy: { id: r.invitedById, name: r.invitedByName },
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    status: r.live ? "pending" : "expired",
  }));
}

/** The open, unexpired invitation a token belongs to, or null (one answer for every failure). */
export async function findInviteByToken(
  db: KobeDb,
  token: unknown,
): Promise<{ readonly id: string; readonly email: string; readonly expiresAt: Date } | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const hash = hashToken(token);
  const [row] = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      expiresAt: invitations.expiresAt,
      tokenHash: invitations.tokenHash,
    })
    .from(invitations)
    .where(and(eq(invitations.tokenHash, hash), open(), unexpired()));
  if (!row || !sameHash(row.tokenHash, hash)) return null;
  return { id: row.id, email: row.email, expiresAt: row.expiresAt };
}

/**
 * Accepts an invitation: creates the user (email verified by possession of the link) and their
 * password credential, and consumes the invitation, in one transaction. The row lock makes the
 * token single-use under concurrency. Null when the token is not open (any reason).
 */
export async function acceptInvite(
  db: KobeDb,
  input: { readonly token: unknown; readonly name: string; readonly passwordHash: string },
): Promise<{ readonly userId: string } | null> {
  if (typeof input.token !== "string" || !TOKEN_PATTERN.test(input.token)) return null;
  const hash = hashToken(input.token);
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select({ id: invitations.id, email: invitations.email, tokenHash: invitations.tokenHash })
      .from(invitations)
      .where(and(eq(invitations.tokenHash, hash), open(), unexpired()))
      .for("update");
    if (!invite || !sameHash(invite.tokenHash, hash)) return null;
    const [user] = await tx
      .insert(users)
      .values({ email: invite.email, name: input.name, emailVerified: true })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (!user) return null;
    await tx.insert(accounts).values({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: input.passwordHash,
    });
    await tx
      .update(invitations)
      .set({ acceptedAt: dbNow, acceptedUserId: user.id })
      .where(eq(invitations.id, invite.id));
    await recordAudit(tx, {
      action: "identity.invitation.accepted",
      actor: { kind: "user", id: user.id },
      target: { invitationId: invite.id, userId: user.id },
    });
    return { userId: user.id };
  });
}
