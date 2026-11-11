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

/**
 * `expectedRole` (KOBE-619): refuse with 409 `changed_since_approval` unless the member's role is
 * still this one, checked under the change's row lock (the Kobe MCP tool sends the approved
 * before-state; the console may too).
 */
export const memberRoleSchema = z
  .object({ role: teamRoleSchema, expectedRole: teamRoleSchema.optional() })
  .strict();

export const activeTeamSchema = z.object({ teamId: idSchema }).strict();

export const siteRoleChangeSchema = z.object({ role: z.enum(["admin", "user"]) }).strict();

export const transferOwnershipSchema = z.object({ userId: idSchema }).strict();
