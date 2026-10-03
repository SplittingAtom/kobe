import { z } from "zod";
import {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_ENTRIES_MAX,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_REASON_MAX,
  BREAK_GLASS_THREADS_MAX,
} from "@kobe/db";

const id = z.uuid().transform((v) => v.toLowerCase());

/** `POST /v1/install/break-glass` (spec D10): one team, optionally one user or one thread. */
export const requestGrantSchema = z
  .strictObject({
    teamId: id,
    reason: z
      .string()
      .trim()
      .min(10, "Explain why in at least 10 characters.")
      .max(BREAK_GLASS_REASON_MAX),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(BREAK_GLASS_MAX_MINUTES)
      .default(BREAK_GLASS_DEFAULT_MINUTES),
    userId: id.optional(),
    threadId: id.optional(),
    legalHold: z.boolean().default(false),
  })
  .refine((v) => v.userId === undefined || v.threadId === undefined, {
    message: "Narrow to one user or one thread, not both.",
  });

export type RequestGrantBody = z.infer<typeof requestGrantSchema>;

export const listGrantsQuerySchema = z.strictObject({
  status: z.enum(["pending", "active", "denied", "revoked", "expired"]).optional(),
  teamId: id.optional(),
});

export const grantThreadsQuerySchema = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(BREAK_GLASS_THREADS_MAX).default(50),
});

export const grantEntriesQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(BREAK_GLASS_ENTRIES_MAX).default(100),
});

export const idParamSchema = id;
