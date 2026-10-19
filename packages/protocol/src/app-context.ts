import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * Model context from MCP Apps (KOBE-439, spec §8 and MA7): what an app put in a visible,
 * removable chip (`ui/update-model-context`), sent with the member's next message as untrusted
 * data. The server checks each part names an app the member can open now, and hands it to Pi as
 * a fenced `<app-context … untrusted="true">` block before the message text.
 */
export const APP_CONTEXT_MAX_BYTES = 8 * 1024;
/** One part per app; at most this many apps live in a thread (MA10). */
export const APP_CONTEXT_MAX_PARTS = 3;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export const appContextDataSchema = z
  .strictObject({
    content: z
      .array(z.looseObject({ type: z.string().max(64) }))
      .max(64)
      .optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((d) => d.content !== undefined || d.structuredContent !== undefined, "empty context");

export const appContextPartSchema = z
  .strictObject({
    connector_id: uuidSchema,
    /** SHA-256 of `connectorId:uri` (KOBE-436). */
    app_id: hex64,
    /** The template the context came from; another one is refused. */
    template_sha256: hex64,
    data: appContextDataSchema,
  })
  .refine((p) => byteLength(p.data) <= APP_CONTEXT_MAX_BYTES, "app context over 8 KiB");
export type AppContextPart = z.infer<typeof appContextPartSchema>;

export const appContextFieldSchema = z
  .array(appContextPartSchema)
  .min(1)
  .max(APP_CONTEXT_MAX_PARTS)
  .refine((parts) => new Set(parts.map((p) => p.app_id)).size === parts.length, "one per app");
