import { z } from "zod";

/**
 * Layout preferences per user (KOBE-202, CE8): they follow the member across devices.
 *
 * - `GET /v1/me/preferences` -> {@link uiPreferencesResponseSchema}: what the caller has stored
 *   (absent key = the default).
 * - `PUT /v1/me/preferences` with {@link uiPreferencesSchema}: stores the keys sent, keeps the
 *   others; `artifact_width: null` goes back to the default (half the space right of the rail).
 *   Unknown keys are refused (400), as are values out of bounds; the threads share is clamped.
 *
 * Room to grow: B4's Detail toggle adds an optional key here.
 */

/** Threads' share of the rail's height over Files (CE5): never squeezing either section out. */
export const THREADS_SHARE_BOUNDS = { min: 0.2, max: 0.8 } as const;

/**
 * The artifact column's width in px (CE7): never under 360 px; the upper bound only keeps the
 * stored value sane (whether it fits is decided on the screen it is applied to).
 */
export const ARTIFACT_WIDTH_BOUNDS = { min: 360, max: 8192 } as const;

/** Largest PUT body the server reads (bytes); the whole document is far smaller. */
export const UI_PREFERENCES_MAX_BODY = 1024;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A share in [0, 1], clamped to {@link THREADS_SHARE_BOUNDS}. */
export const threadsShareSchema = z
  .number()
  .finite()
  .min(0)
  .max(1)
  .transform((n) =>
    round3(Math.min(THREADS_SHARE_BOUNDS.max, Math.max(THREADS_SHARE_BOUNDS.min, n))),
  );

export const uiPreferencesSchema = z.strictObject({
  rail_collapsed: z.boolean().optional(),
  threads_share: threadsShareSchema.optional(),
  artifact_width: z
    .number()
    .int()
    .min(ARTIFACT_WIDTH_BOUNDS.min)
    .max(ARTIFACT_WIDTH_BOUNDS.max)
    .nullable()
    .optional(),
});
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;

export const uiPreferencesResponseSchema = z.strictObject({ preferences: uiPreferencesSchema });
export type UiPreferencesResponse = z.infer<typeof uiPreferencesResponseSchema>;

/**
 * Reads a stored or received document leniently: each known key that is valid on its own is kept,
 * anything else (unknown keys, values from an older shape) is dropped. Never throws.
 */
export function readUiPreferences(raw: unknown): UiPreferences {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const shape = uiPreferencesSchema.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
    const parsed = shape[key].safeParse(record[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as UiPreferences;
}
