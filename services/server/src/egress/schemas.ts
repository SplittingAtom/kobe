import { EGRESS_PRESETS, parseDomainPattern } from "@kobe/db";
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

export const presetSchema = z.enum(EGRESS_PRESETS);

/** Install-wide cap on ceiling rows (presets included): a ceiling is a short, reviewed list. */
export const MAX_CEILING_DOMAINS = 500;
