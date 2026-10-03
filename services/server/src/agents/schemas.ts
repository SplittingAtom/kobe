import { z } from "zod";
import { agentSlugSchema } from "@kobe/agent-file";
import { agentStatus } from "@kobe/db";

export const agentIdSchema = z.uuid();

const creatableScope = z.enum(["team", "personal"]);

/** Meta next to the definition when a member creates (or imports) an agent. */
export const createMetaSchema = z
  .object({ scope: creatableScope, slug: agentSlugSchema.optional() })
  .strict();

/** Meta when an install admin creates (or imports) a gallery agent. */
export const galleryCreateMetaSchema = z.object({ slug: agentSlugSchema.optional() }).strict();

/** Replacing a draft takes no meta: slugs are immutable. */
export const updateMetaSchema = z.object({}).strict();

export const forkSchema = z
  .object({ scope: creatableScope, slug: agentSlugSchema.optional() })
  .strict();

export const agentStatusSchema = z.object({ status: z.enum(agentStatus.enumValues) }).strict();

export const listQuerySchema = z
  .object({
    scope: z.enum(["team", "personal", "gallery"]).optional(),
    /** Archived agents (KOBE-46) are left out unless asked for (inventory, KOBE-48). */
    include_archived: z.enum(["true", "false"]).optional(),
  })
  .strict();

/** A version number in a path or body (1 … 2^31-1, Postgres integer). */
export const versionNumberSchema = z.number().int().min(1).max(2_147_483_647);

/** `/:id/versions/:version` path parameter. */
export const versionParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .transform(Number)
  .pipe(versionNumberSchema);

/** `POST /:id/rollback`: republish this older version as the newest (D19). */
export const rollbackSchema = z.object({ version: versionNumberSchema }).strict();

export const VERSION_PAGE_DEFAULT = 50;
export const VERSION_PAGE_MAX = 200;

/** `GET /:id/versions`: newest first; `before` continues from the previous page's last version. */
export const versionsQuerySchema = z
  .object({
    before: versionParamSchema.optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(VERSION_PAGE_MAX))
      .optional(),
  })
  .strict();
