import { EGRESS_PRESETS, MAX_HOST_LENGTH, parseDomainPattern } from "@kobe/db";
import { EGRESS_BLOCKED_REASONS } from "@kobe/protocol";
import { z } from "zod";

/** An admin-entered domain pattern, canonicalized (`PyPI.org` → `pypi.org`, IDNA → ASCII). */
export const domainPatternSchema = z
  .string()
  .max(300)
  .transform((raw, ctx) => {
    const parsed = parseDomainPattern(raw);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: `domain ${parsed.reason}` });
      return z.NEVER;
    }
    return parsed.pattern;
  });

export const addCeilingBodySchema = z.strictObject({
  domain: domainPatternSchema,
  note: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\p{Cc}]*$/u, "note must not contain control characters")
    .nullish(),
});

export const ceilingMembershipBodySchema = z.strictObject({ in_ceiling: z.boolean() });

/** A ceiling domain's flags (KOBE-602): in or out of the ceiling, internal (same cluster) or not. */
export const ceilingFlagsBodySchema = z
  .strictObject({
    in_ceiling: z.boolean().optional(),
    internal: z.boolean().optional(),
    /**
     * Whether the caller saw it in the ceiling (KOBE-622): refused `changed_since_approval` under
     * the row lock when that changed (the Kobe MCP tool sends the approved before-state).
     */
    expected_in_ceiling: z.boolean().optional(),
  })
  .refine((b) => b.in_ceiling !== undefined || b.internal !== undefined, {
    message: "send in_ceiling, internal or both",
  });

export const presetSchema = z.enum(EGRESS_PRESETS);

/** Site-wide cap on ceiling rows (presets included): a ceiling is a short, reviewed list. */
export const MAX_CEILING_DOMAINS = 500;

/** `POST /v1/egress/requests` (KOBE-39; `reason` KOBE-602). */
export const egressRequestCreateBodySchema = z.strictObject({
  domain: z
    .string()
    .min(1)
    .max(MAX_HOST_LENGTH + 1),
  thread_id: z.uuid().optional(),
  /** The blocked notice's reason: `forbidden_address` asks for an internal pattern (EA4). */
  reason: z.enum(EGRESS_BLOCKED_REASONS).optional(),
});
