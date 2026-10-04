import { MIN_SECRET_LENGTH } from "@kobe/db";
import { z } from "zod";

/**
 * Header injection secret (KOBE-39): seals the team's injected header values in Postgres; the
 * egress proxy holds the same secret to open them. Unset: header injection is off (the API answers
 * 503 and nothing is sealed). `_PREVIOUS` keeps values sealed before a rotation readable.
 */
const schema = z.object({
  KOBE_EGRESS_HEADER_SECRET: z
    .string()
    .default("")
    .refine(
      (v) => v === "" || v.length >= MIN_SECRET_LENGTH,
      `KOBE_EGRESS_HEADER_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    ),
  KOBE_EGRESS_HEADER_SECRET_PREVIOUS: z
    .string()
    .default("")
    .refine(
      (v) => v === "" || v.length >= MIN_SECRET_LENGTH,
      `KOBE_EGRESS_HEADER_SECRET_PREVIOUS must be at least ${MIN_SECRET_LENGTH} characters`,
    ),
});

/** The secrets (current first), or undefined when header injection is not configured. */
export function loadEgressHeaderSecrets(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | undefined {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const { KOBE_EGRESS_HEADER_SECRET: current, KOBE_EGRESS_HEADER_SECRET_PREVIOUS: previous } =
    parsed.data;
  if (current === "") {
    if (previous !== "") {
      throw new Error(
        "Invalid configuration: KOBE_EGRESS_HEADER_SECRET_PREVIOUS needs KOBE_EGRESS_HEADER_SECRET",
      );
    }
    return undefined;
  }
  return previous === "" ? [current] : [current, previous];
}
