import { z } from "zod";

/**
 * Items an MCP App put in the composer as chips (KOBE-490): an app's `ui/message` carries MCP
 * `resource_link` blocks, each a removable chip; the member's message names the chips still shown
 * (`references`), and the server appends one fixed line after the member's text so the model
 * sees them ("Referenced: `cat.ns.orders` (table), …"). The chat recognises the line in history
 * and shows it as the same chips under the sent message. Only names and kinds travel: the uri
 * stays in the browser (it de-duplicates the chips).
 */
export const ITEM_REFERENCES_MAX = 20;
export const ITEM_REFERENCE_NAME_MAX = 512;
/** `_meta["io.kobe/item-kind"]`; anything else (or none) is sent as {@link GENERIC_ITEM_KIND}. */
export const ITEM_KIND_META_KEY = "io.kobe/item-kind";
export const GENERIC_ITEM_KIND = "item";
export const ITEM_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** No backtick (the line's quote), no control, format or line-separator characters. */
const NAME_PATTERN = /^[^`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

export const itemReferenceNameSchema = z
  .string()
  .min(1)
  .max(ITEM_REFERENCE_NAME_MAX)
  .regex(NAME_PATTERN)
  .refine((s) => s.trim() === s, "leading or trailing space");

export const itemReferenceSchema = z.strictObject({
  name: itemReferenceNameSchema,
  kind: z.string().regex(ITEM_KIND_PATTERN),
});
export type ItemReference = z.infer<typeof itemReferenceSchema>;

const keyOf = (r: ItemReference) => `${r.kind}\u0000${r.name}`;

export const itemReferencesFieldSchema = z
  .array(itemReferenceSchema)
  .min(1)
  .max(ITEM_REFERENCES_MAX)
  .refine((refs) => new Set(refs.map(keyOf)).size === refs.length, "duplicate references");

const PREFIX = "\n\nReferenced: ";
const ONE = "`([^`\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,512})` \\(([a-z][a-z0-9-]{0,31})\\)";
const LINE = new RegExp(`${PREFIX}(${ONE}(?:, ${ONE}){0,${ITEM_REFERENCES_MAX - 1}})$`, "u");
const EACH = new RegExp(ONE, "gu");

/** The member's text, then a blank line and the server's line naming the references. */
export function withItemReferences(refs: readonly ItemReference[], text: string): string {
  if (refs.length === 0) return text;
  return `${text}${PREFIX}${refs.map((r) => `\`${r.name}\` (${r.kind})`).join(", ")}`;
}

/** The references a run input or sent message ends with, and the text before the line. */
export function splitItemReferences(text: string): {
  readonly references: readonly ItemReference[];
  readonly rest: string;
} {
  const match = LINE.exec(text);
  if (!match) return { references: [], rest: text };
  const references = [...(match[1] ?? "").matchAll(EACH)].map((m) => ({
    name: m[1] ?? "",
    kind: m[2] ?? GENERIC_ITEM_KIND,
  }));
  return { references, rest: text.slice(0, match.index) };
}
