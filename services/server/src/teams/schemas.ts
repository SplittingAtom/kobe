import { z } from "zod";
import { TEAM_ROLES, type TeamRole } from "@kobe/db";

/** Mirrors the `teams_slug_format` check: names the namespace `kobe-team-<slug>` (≤ 63 chars). */
export const teamSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/,
    "slug must be 1-32 lowercase letters, digits or hyphens, starting and ending alphanumeric",
  );

export const teamNameSchema = z.string().trim().min(1, "name is required").max(100);

export const teamRoleSchema = z.enum(TEAM_ROLES as [TeamRole, ...TeamRole[]]);

export const idSchema = z.uuid();

export const createTeamSchema = z
  .object({ slug: teamSlugSchema, name: teamNameSchema, adminUserId: idSchema })
  .strict();

export const renameTeamSchema = z.object({ name: teamNameSchema }).strict();

export const addMemberSchema = z
  .object({ email: z.email().max(254), role: teamRoleSchema })
  .strict();

export const memberRoleSchema = z.object({ role: teamRoleSchema }).strict();

export const activeTeamSchema = z.object({ teamId: idSchema }).strict();

export const installRoleChangeSchema = z.object({ role: z.enum(["admin", "user"]) }).strict();

export const transferOwnershipSchema = z.object({ userId: idSchema }).strict();
