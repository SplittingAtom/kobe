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
/** A dotted name, not prose: the line is model-visible and unfenced (KOBE-490 review MEDIUM-1). */
export const ITEM_REFERENCE_NAME_MAX = 200;
/** `_meta["io.kobe/item-kind"]`; anything outside {@link ITEM_KINDS} is {@link GENERIC_ITEM_KIND}. */
export const ITEM_KIND_META_KEY = "io.kobe/item-kind";
export const GENERIC_ITEM_KIND = "item";
/** The kinds Kobe knows (an icon each); `item` is the generic one. */
export const ITEM_KINDS = [
  "catalog",
  "namespace",
  "schema",
  "table",
  "view",
  "column",
  "file",
  "folder",
  "query",
  "dashboard",
  "document",
  GENERIC_ITEM_KIND,
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** A known kind, else the generic one. */
export function itemKindOf(value: unknown): ItemKind {
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value)
    ? (value as ItemKind)
    : GENERIC_ITEM_KIND;
}

/**
 * Refused in a name: the backtick (the line's quote), control, format and line-separator
 * characters, and every default-ignorable code point (variation selectors U+FE00–FE0F and
 * U+E0100–E01EF, fillers, …): the member must see exactly what the model gets.
 */
const REFUSED =
  "`\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u{FE00}-\\u{FE0F}\\u{E0100}-\\u{E01EF}";
const NAME_PATTERN = new RegExp(`^[^${REFUSED}]+$`, "u");

export const itemReferenceNameSchema = z
  .string()
  .min(1)
  .max(ITEM_REFERENCE_NAME_MAX)
  .regex(NAME_PATTERN)
  .refine((s) => s.trim() === s, "leading or trailing space");

export const itemReferenceSchema = z.strictObject({
  name: itemReferenceNameSchema,
  kind: z.enum(ITEM_KINDS),
});
export type ItemReference = z.infer<typeof itemReferenceSchema>;

const keyOf = (r: ItemReference) => `${r.kind}\u0000${r.name}`;

export const itemReferencesFieldSchema = z
  .array(itemReferenceSchema)
  .min(1)
  .max(ITEM_REFERENCES_MAX)
  .refine((refs) => new Set(refs.map(keyOf)).size === refs.length, "duplicate references");

const PREFIX = "\n\nReferenced: ";
const ONE = `\`([^${REFUSED}]{1,${ITEM_REFERENCE_NAME_MAX}})\` \\((${ITEM_KINDS.join("|")})\\)`;
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
    kind: itemKindOf(m[2]),
  }));
  return { references, rest: text.slice(0, match.index) };
}
