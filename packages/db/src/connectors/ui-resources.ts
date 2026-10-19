import { z } from "zod";

/**
 * MCP Apps templates (KOBE-433, spec mcp-apps-host §5): the shapes stored in
 * `connector_ui_resources` beside the columns. Read side fails closed: a proposal that does not
 * parse is treated as absent (the row stays not approvable until the next refresh).
 */

/** `ui://` followed by at least one non-space character. */
export const UI_RESOURCE_URI_PATTERN = /^ui:\/\/\S+$/;

const json = z.unknown();

/**
 * The declared `_meta.ui` of a template that Kobe pins (part of the pinned hash, so a change of
 * declared CSP or permissions is drift). v1 ignores `csp` when rendering (T3).
 */
export const uiResourceMetaSchema = z
  .object({
    csp: json.optional(),
    permissions: json.optional(),
    domain: json.optional(),
    prefersBorder: json.optional(),
  })
  .strip();
export type UiResourceMeta = z.infer<typeof uiResourceMetaSchema>;

/** Why a live template could not be pinned (MA9, §5). */
export const UI_RESOURCE_FAILURES = ["ui_resource_invalid", "ui_resource_hash_mismatch"] as const;
export type UiResourceFailure = (typeof UI_RESOURCE_FAILURES)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** A live template awaiting review: valid bytes, or the reason the live one cannot be pinned. */
export const proposedUiResourceSchema = z.union([
  z.strictObject({
    mime_type: z.string(),
    html: z.string(),
    sha256: hex64,
    meta: uiResourceMetaSchema,
    pinned_hash: hex64,
  }),
  z.strictObject({ invalid: z.enum(UI_RESOURCE_FAILURES) }),
]);
export type ProposedUiResource = z.infer<typeof proposedUiResourceSchema>;

export function parseProposedUiResource(value: unknown): ProposedUiResource | undefined {
  const parsed = proposedUiResourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
