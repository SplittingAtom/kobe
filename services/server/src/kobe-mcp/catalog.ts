import { z } from "zod";
import type { SitePermission, TeamPermission } from "../authz/permissions.js";

/**
 * The Kobe MCP tool catalog framework (KOBE-619, spec kobe-admin-mcp §5, KA3). Each admin tool is
 * one Team console or Site console action: the console page's permission, and the console's own
 * route, which the executor calls in process as the person (`delegation.ts`), so there is one
 * implementation of every action and a tool can do nothing its route refuses the person.
 *
 * The catalog is code, shipped and hashed with the release: no pinning, no drift (a Kobe upgrade
 * is the review). Names are `<area>_<verb>`; Pi sees `mcp__<connector>__<name>`.
 */

export type KobeRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One console route call: under `/v1`, with a JSON body for changes. */
export interface KobeRoute {
  readonly method: KobeRouteMethod;
  /** Path under `/v1`, starting with `/` (ids are validated by the input schema first). */
  readonly path: string;
  /** Query parameters (a route's filters, or a removal's before-state condition). */
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** A route's answer as the executor saw it. */
export interface KobeRouteAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Calls a console route as the delegated person (same delegation as the tool call). */
export type KobeRouteCaller = (route: KobeRoute) => Promise<KobeRouteAnswer>;

/**
 * Whether the target still has the before-state the person approved (§5): `same`, `changed`
 * (refused `changed_since_approval`), or a refusal of its own (e.g. `not_a_member` when the
 * target is gone).
 *
 * The pre-check gives the model a precise answer; it is not the guarantee. Every write route a
 * tool calls must also take the approved before-state in its request and refuse with 409
 * `changed_since_approval` under the change's own lock (e.g. `expectedRole` on PATCH
 * `/team/members/:id`), so nothing can slip in between the check and the change.
 */
export type BeforeState = "same" | "changed" | { readonly code: string; readonly message: string };

/** Results are compact and bounded (§5). */
export const KOBE_RESULT_MAX_BYTES = 64 * 1024;
export const KOBE_PAGE_MAX = 50;

/**
 * What the catalog infers a schema's type from: its `parse`. Inferring through `z.ZodType<I>`
 * instead makes the compiler expand every zod schema of every tool (KOBE-621: the server's
 * typecheck ran out of memory). The values are zod schemas: {@link zodOf} gives them back.
 */
export interface Schema<T> {
  parse(data: unknown): T;
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/** A catalog schema as the zod schema it is (for `z.toJSONSchema`). */
export const zodOf = (schema: Schema<unknown>): z.ZodType => schema as unknown as z.ZodType;

interface ToolBase<I, O> {
  /** `<area>_<verb>`, lowercase. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Strict: unknown keys are refused, so the approved input is exactly what runs. */
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly route: (input: I) => KobeRoute;
  /** The route's 2xx answer reduced to the output schema (never more than the tool promises). */
  readonly reduce: (body: unknown, input: I) => O;
}

interface ReadTool {
  readonly readOnly: true;
}

interface WriteTool<I> {
  readonly readOnly: false;
  /** Removes or overwrites something that cannot be put back by the same tool. */
  readonly destructive: boolean;
  /**
   * Reads the target's current state as the person and compares it with the before-state named in
   * the input (and covered by the signed approval): `changed` refuses with `changed_since_approval`.
   * The route call must carry the same before-state as a condition ({@link BeforeState}).
   */
  readonly before: (input: I, call: KobeRouteCaller) => Promise<BeforeState>;
  /** The card's one-line summary, built from the input only (never model text). */
  readonly summary: (input: I) => string;
}

type Scoped =
  | { readonly scope: "team"; readonly permission: TeamPermission }
  | { readonly scope: "site"; readonly permission: SitePermission };

export type KobeTool<I = unknown, O = unknown> = ToolBase<I, O> &
  Scoped &
  (ReadTool | WriteTool<I>);

export type KobeWriteTool<I = unknown, O = unknown> = KobeTool<I, O> & WriteTool<I>;

/** Builds a tool with its input and output types checked against each other. */
export function kobeTool<I, O>(tool: KobeTool<I, O>): KobeTool {
  return tool as unknown as KobeTool;
}

export const isWriteTool = (tool: KobeTool): tool is KobeWriteTool => !tool.readOnly;

/** A paging cursor: an opaque offset (base64url of a decimal), bounded. */
export const cursorSchema = z
  .string()
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/** A route's own opaque cursor passed through (base64url, bounded). */
export const routeCursorSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

/** A path segment from a validated value (a domain, an alias): percent-encoded, `*` too. */
export const segment = (value: string): string => encodeURIComponent(value).replace(/\*/g, "%2A");

/** One page of `rows` from the cursor, at most {@link KOBE_PAGE_MAX}. */
export function page<T>(
  rows: readonly T[],
  cursor: string | undefined,
): { rows: T[]; next_cursor?: string } {
  const start = decodeCursor(cursor);
  const slice = rows.slice(start, start + KOBE_PAGE_MAX);
  const next = start + slice.length;
  return next < rows.length ? { rows: slice, next_cursor: encodeCursor(next) } : { rows: slice };
}
