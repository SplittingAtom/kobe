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
 * `detail_expanded` (KOBE-208, CE12): the Detail toggle, all reasoning and tool cards open.
 * `rail_width` (KOBE-305): the expanded rail's dragged width; `null` goes back to the default.
 * `rail_panels` (KOBE-419): which of the rail's panels show, Threads, Files or both (the default);
 * never none, so the rail always has something to show. Since KOBE-453 the threads are a panel:
 * "both" or "files" shows the rail's Files | Apps section, "threads" hides it.
 * `rail_tab` (KOBE-448): the tab that section shows, Files (the default) or Apps.
 * `workbench_editor_width` (KOBE-459): the Workbench editor rail's dragged width; `null` goes back
 * to the default (the rail takes the width the file tree leaves).
 * `rail_picker` (KOBE-460): the picker app (its app id) the Apps tab renders live, or `null` for
 * None. Absent (never chosen) shows the first live picker (KOBE-461); a remembered picker that is
 * not live for the member shows the first live one, with a note.
 */

/** Threads' share of the rail's height over Files (CE5): never squeezing either section out. */
export const THREADS_SHARE_BOUNDS = { min: 0.2, max: 0.8 } as const;

/**
 * The artifact column's width in px (CE7): never under 360 px; the upper bound only keeps the
 * stored value sane (whether it fits is decided on the screen it is applied to).
 */
export const ARTIFACT_WIDTH_BOUNDS = { min: 360, max: 8192 } as const;

/**
 * The expanded rail's dragged width in px (KOBE-305): from 200 (names still readable) to 560;
 * whether it fits beside the conversation is decided on the screen it is applied to.
 */
export const RAIL_WIDTH_BOUNDS = { min: 200, max: 560 } as const;

/**
 * The Workbench editor rail's dragged width in px (KOBE-459): never under 320 (the frontmatter
 * form stays usable); the upper bound only keeps the stored value sane (whether it fits beside the
 * file tree is decided on the screen it is applied to).
 */
export const WORKBENCH_EDITOR_WIDTH_BOUNDS = { min: 320, max: 8192 } as const;

/** The rail's panels on screen (KOBE-419): one of them, or both. */
export const RAIL_PANELS = ["both", "threads", "files"] as const;
export type RailPanels = (typeof RAIL_PANELS)[number];

/** The rail section's tabs (KOBE-448): the member's last one is kept. */
export const RAIL_TABS = ["files", "apps"] as const;
export type RailTab = (typeof RAIL_TABS)[number];

/** An MCP App's id (KOBE-436): the SHA-256 of `connectorId:uri`, lowercase hex. */
const APP_ID_PATTERN = /^[0-9a-f]{64}$/;

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
  detail_expanded: z.boolean().optional(),
  rail_width: z
    .number()
    .int()
    .min(RAIL_WIDTH_BOUNDS.min)
    .max(RAIL_WIDTH_BOUNDS.max)
    .nullable()
    .optional(),
  rail_panels: z.enum(RAIL_PANELS).optional(),
  rail_tab: z.enum(RAIL_TABS).optional(),
  workbench_editor_width: z
    .number()
    .int()
    .min(WORKBENCH_EDITOR_WIDTH_BOUNDS.min)
    .max(WORKBENCH_EDITOR_WIDTH_BOUNDS.max)
    .nullable()
    .optional(),
  rail_picker: z.string().regex(APP_ID_PATTERN).nullable().optional(),
});
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;

export const uiPreferencesResponseSchema = z.strictObject({ preferences: uiPreferencesSchema });
export type UiPreferencesResponse = z.infer<typeof uiPreferencesResponseSchema>;

/**
 * The shape a stored document is read with: like {@link uiPreferencesSchema}, but a share outside
 * the rail's bounds is dropped rather than clamped (it no longer fits, so the default applies).
 */
const storedShape = {
  ...uiPreferencesSchema.shape,
  threads_share: z.number().min(THREADS_SHARE_BOUNDS.min).max(THREADS_SHARE_BOUNDS.max).optional(),
};

/**
 * Reads a stored or received document leniently: each known key that is valid on its own is kept,
 * anything else (unknown keys, values from an older shape) is dropped. Never throws.
 */
export function readUiPreferences(raw: unknown): UiPreferences {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(storedShape) as (keyof typeof storedShape)[];
  return Object.fromEntries(
    keys.flatMap((key) => {
      if (!Object.hasOwn(record, key) || record[key] === undefined) return [];
      const parsed = storedShape[key].safeParse(record[key]);
      return parsed.success ? [[key, parsed.data]] : [];
    }),
  ) as UiPreferences;
}
