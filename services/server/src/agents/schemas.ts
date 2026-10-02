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
  .object({ scope: z.enum(["team", "personal", "gallery"]).optional() })
  .strict();
