/**
 * A Lakehouse Picker item dragged out of its frame onto the composer (KOBE-551). The picker (an
 * MCP App in a sandboxed frame) starts a native drag; the drag carries the item as JSON under
 * {@link LAKEHOUSE_DRAG_TYPE} and its backticked identifier as `text/plain`. While hovering a
 * browser shows only the types; the JSON is readable on drop. Nothing from the app is trusted:
 * only an item whose identifier and uri are exactly its segments becomes the `ui/message` content
 * a click on the picker sends (a text block, then one resource_link), which the bridge's
 * `appMessageOf` then turns into the composer's chip as for the click.
 */
import { ITEM_KIND_META_KEY } from "@kobe/protocol";

export const LAKEHOUSE_DRAG_TYPE = "application/x-catalyst-lakehouse+json";
export const IDENTIFIER_MAX = 511;
export const URI_MAX = 2047;
/** The JSON as dropped, before it is parsed: well above the fields' own caps. */
const PAYLOAD_MAX = 8 * 1024;
const URI_PREFIX = "catalyst://lakehouse/";
const SEGMENT = /^[a-z][a-z0-9_]*$/;

/** The chip's "from …" (the picker's title on the gate install; a drag names no app). */
export const LAKEHOUSE_DROP_FROM = "Lakehouse Picker";
export const LAKEHOUSE_DROP_REFUSED =
  "This item can't go into a message: the app sent an identifier Kobe can't use.";

/** The segments each kind has: catalog, then namespace, then name. */
const SHAPES = {
  catalog: { namespace: false, name: false },
  namespace: { namespace: true, name: false },
  table: { namespace: true, name: true },
  view: { namespace: true, name: true },
} as const;
type LakehouseKind = keyof typeof SHAPES;

const typesOf = (dt: DataTransfer | null): readonly string[] => Array.from(dt?.types ?? []);

/** True while the drag is a Lakehouse Picker item (its type name; the data waits for the drop). */
export const carriesLakehouseItem = (dt: DataTransfer | null): boolean =>
  typesOf(dt).includes(LAKEHOUSE_DRAG_TYPE);

/** The dropped item's JSON; only readable in the drop event. Empty when there is none. */
export const droppedLakehouseItem = (dt: DataTransfer): string => dt.getData(LAKEHOUSE_DRAG_TYPE);

function parse(raw: string): Record<string, unknown> | undefined {
  if (raw === "" || raw.length > PAYLOAD_MAX) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The item's segments, or undefined when a field is missing, extra or not one segment. */
function segmentsOf(item: Record<string, unknown>): string[] | undefined {
  const kind = item["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(SHAPES, kind)) return undefined;
  const shape = SHAPES[kind as LakehouseKind];
  const fields: [unknown, boolean][] = [
    [item["catalog"], true],
    [item["namespace"], shape.namespace],
    [item["name"], shape.name],
  ];
  const segments: string[] = [];
  for (const [value, wanted] of fields) {
    if (!wanted) {
      if (value !== undefined) return undefined;
      continue;
    }
    if (typeof value !== "string" || !SEGMENT.test(value)) return undefined;
    segments.push(value);
  }
  return segments;
}

/**
 * The `ui/message` content a click on the picker sends for the dropped item, or undefined when
 * the JSON is not a well-formed item (kind one of four, every segment `^[a-z][a-z0-9_]*$`, the
 * identifier the dotted segments and the uri their `catalyst://lakehouse/` form, both bounded).
 */
export function lakehouseItemContent(raw: string): readonly Record<string, unknown>[] | undefined {
  const item = parse(raw);
  const segments = item === undefined ? undefined : segmentsOf(item);
  if (item === undefined || segments === undefined) return undefined;
  const identifier = segments.join(".");
  const uri = URI_PREFIX + segments.join("/");
  if (identifier.length > IDENTIFIER_MAX || uri.length > URI_MAX) return undefined;
  if (item["identifier"] !== identifier || item["uri"] !== uri) return undefined;
  return [
    { type: "text", text: `\`${identifier}\`` },
    {
      type: "resource_link",
      uri,
      name: identifier,
      title: segments.at(-1),
      _meta: { [ITEM_KIND_META_KEY]: item["kind"] },
    },
  ];
}
