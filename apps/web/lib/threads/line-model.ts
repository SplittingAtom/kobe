/**
 * The geometry of the Threads panel's thread–file lines (KOBE-612, spec thread-file-map §5): from
 * the rows' boxes and the links to line segments, closed-folder aggregation, off-screen markers
 * and a cap. Pure: the panel measures the DOM and draws what this returns.
 *
 * Lines run from a thread row's right edge to a file row's left edge, whichever side is the
 * source. A file in a closed folder links to the nearest visible folder, with a count; a target
 * row scrolled out of its rail's view becomes an "N more above/below" marker; a target with no
 * row at all (not listed in the tree, a thread in another folder) is counted as `unplaced`.
 */
import type { FileAccess } from "./file-links";

/** A box in the overlay's coordinates (px from its top-left corner). */
export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Which rail a row is in: a thread row, or a file or folder of the workspace rail. */
export type Side = "thread" | "file";

export interface LineTarget {
  /** A file path (when the source is a thread) or a thread id (when it is a file). */
  readonly key: string;
  readonly access: FileAccess;
}

export interface LineSource {
  readonly side: Side;
  /** A thread id or a workspace path. */
  readonly key: string;
  readonly box: Box;
  /** The source rail's visible region: a source scrolled out of it draws nothing. */
  readonly viewport: Box;
  readonly targets: readonly LineTarget[];
}

/** The other rail's rows on screen (rendered, maybe scrolled away) and its visible region. */
export interface TargetRail {
  readonly rows: ReadonlyMap<string, Box>;
  readonly viewport: Box;
}

export interface Line {
  /** `${source}→${anchor}`: stable for React keys. */
  readonly id: string;
  readonly sourceKey: string;
  /** The row the line ends on: the target itself, or the visible folder holding it. */
  readonly anchor: string;
  /** Write if any target it stands for was written (solid), else read (dashed; TFM1). */
  readonly access: FileAccess;
  /** How many targets it stands for (more than one: a badge). */
  readonly count: number;
  /** It ends on a folder standing for files inside it (closed). */
  readonly aggregated: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Marker {
  readonly id: string;
  /** The rail the hidden targets are in. */
  readonly side: Side;
  readonly position: "above" | "below";
  readonly count: number;
  readonly x: number;
  readonly y: number;
}

export interface LinePlan {
  readonly lines: readonly Line[];
  readonly markers: readonly Marker[];
  /** Lines beyond the cap ("+N"). */
  readonly overflow: number;
  /** Targets with no row in the other rail (counted, not drawn). */
  readonly unplaced: number;
}

/** About the most lines drawn at once (spec §5); the rest are "+N". */
export const LINE_CAP = 30;

const middle = (b: Box) => (b.top + b.bottom) / 2;

/** `a/b/c` → `a/b`; the top level → "". */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The row a target lands on: itself, or (files) its nearest ancestor with a row. */
export function anchorOf(
  key: string,
  side: Side,
  rows: ReadonlyMap<string, Box>,
): string | undefined {
  if (rows.has(key)) return key;
  if (side !== "file") return undefined;
  for (let p = parentOf(key); p !== ""; p = parentOf(p)) {
    if (rows.has(p)) return p;
  }
  return undefined;
}

interface Group {
  anchor: string;
  access: FileAccess;
  count: number;
  aggregated: boolean;
}

function groupTargets(source: LineSource, rail: TargetRail) {
  const targetSide: Side = source.side === "thread" ? "file" : "thread";
  const groups = new Map<string, Group>();
  let unplaced = 0;
  for (const t of source.targets) {
    const anchor = anchorOf(t.key, targetSide, rail.rows);
    if (anchor === undefined) {
      unplaced += 1;
      continue;
    }
    const g = groups.get(anchor);
    if (g) {
      g.count += 1;
      if (t.access === "write") g.access = "write";
      if (anchor !== t.key) g.aggregated = true;
    } else {
      groups.set(anchor, { anchor, access: t.access, count: 1, aggregated: anchor !== t.key });
    }
  }
  return { targetSide, groups: [...groups.values()], unplaced };
}

/** One source's lines and markers, before the cap. */
function planOne(source: LineSource, rail: TargetRail) {
  const lines: Line[] = [];
  const markers: Marker[] = [];
  const { targetSide, groups, unplaced } = groupTargets(source, rail);
  const y = middle(source.box);
  if (y < source.viewport.top || y > source.viewport.bottom) {
    return { lines, markers, unplaced: 0 };
  }
  const above = { count: 0, x: 0 };
  const below = { count: 0, x: 0 };
  for (const g of groups) {
    const box = rail.rows.get(g.anchor);
    if (!box) continue;
    const ty = middle(box);
    const tx = targetSide === "file" ? box.left : box.right;
    const off = ty < rail.viewport.top ? above : ty > rail.viewport.bottom ? below : null;
    if (off) {
      off.count += g.count;
      off.x = tx;
      continue;
    }
    const sx = source.side === "thread" ? source.box.right : source.box.left;
    const [x1, y1, x2, y2] = source.side === "thread" ? [sx, y, tx, ty] : [tx, ty, sx, y];
    lines.push({
      id: `${source.key}→${g.anchor}`,
      sourceKey: source.key,
      anchor: g.anchor,
      access: g.access,
      count: g.count,
      aggregated: g.aggregated,
      x1,
      y1,
      x2,
      y2,
    });
  }
  const edge = (position: "above" | "below", m: { count: number; x: number }) =>
    m.count === 0
      ? []
      : [
          {
            id: `${source.key}:${position}`,
            side: targetSide,
            position,
            count: m.count,
            x: m.x,
            y: position === "above" ? rail.viewport.top : rail.viewport.bottom,
          },
        ];
  markers.push(...edge("above", above), ...edge("below", below));
  lines.sort((a, b) => (targetSide === "file" ? a.y2 - b.y2 : a.y1 - b.y1));
  return { lines, markers, unplaced };
}

/**
 * The lines for every active source (hovered, focused, pinned), in order: the first source's lines
 * come first, so the hovered row keeps its lines when pins fill the cap. A source listed twice
 * draws once.
 */
export function planLines(
  sources: readonly LineSource[],
  rails: Readonly<Record<Side, TargetRail>>,
  cap: number = LINE_CAP,
): LinePlan {
  const seen = new Set<string>();
  const lines: Line[] = [];
  const markers: Marker[] = [];
  let unplaced = 0;
  let overflow = 0;
  for (const source of sources) {
    const id = `${source.side}:${source.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const one = planOne(source, rails[source.side === "thread" ? "file" : "thread"]);
    unplaced += one.unplaced;
    markers.push(...one.markers);
    for (const line of one.lines) {
      if (lines.length < cap) lines.push(line);
      else overflow += 1;
    }
  }
  return { lines, markers: mergeMarkers(markers), overflow, unplaced };
}

/** Markers of several sources at the same edge of the same rail add up into one. */
function mergeMarkers(markers: readonly Marker[]): Marker[] {
  const out = new Map<string, Marker>();
  for (const m of markers) {
    const key = `${m.side}:${m.position}`;
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, count: prev.count + m.count } : { ...m, id: key });
  }
  return [...out.values()];
}

/** The SVG path of a line: a horizontal S-curve between its ends. */
export function curvePath(line: Pick<Line, "x1" | "y1" | "x2" | "y2">): string {
  const mid = (line.x1 + line.x2) / 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(line.x1)} ${r(line.y1)} C ${r(mid)} ${r(line.y1)}, ${r(mid)} ${r(line.y2)}, ${r(line.x2)} ${r(line.y2)}`;
}

/** The words of a marker: "3 more above". */
export function markerText(m: Pick<Marker, "count" | "position">): string {
  return `${m.count} more ${m.position}`;
}

/** A box relative to `origin` (both from getBoundingClientRect). */
export function relativeBox(rect: Box, origin: Pick<Box, "top" | "left">): Box {
  return {
    top: rect.top - origin.top,
    bottom: rect.bottom - origin.top,
    left: rect.left - origin.left,
    right: rect.right - origin.left,
  };
}

/** The overlap of two boxes (an empty box at `a`'s top when they do not meet). */
export function intersect(a: Box, b: Box): Box {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  return {
    top,
    left,
    bottom: Math.max(top, Math.min(a.bottom, b.bottom)),
    right: Math.max(left, Math.min(a.right, b.right)),
  };
}
