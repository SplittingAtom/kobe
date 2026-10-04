import { z } from "zod";
import { LEGAL_HOLD_REASON_MAX } from "@kobe/db";

const id = z.uuid().transform((v) => v.toLowerCase());
const reason = z
  .string()
  .trim()
  .min(10, "Explain why in at least 10 characters.")
  .max(LEGAL_HOLD_REASON_MAX);

/** `POST /v1/install/legal-hold` (spec D18): one team, optionally one user in it. */
export const requestHoldSchema = z.strictObject({
  teamId: id,
  userId: id.optional(),
  reason,
});
export type RequestHoldBody = z.infer<typeof requestHoldSchema>;

/** `POST /v1/install/legal-hold/{id}/release`: why the hold can end. */
export const requestReleaseSchema = z.strictObject({ reason });

export const idParamSchema = id;
