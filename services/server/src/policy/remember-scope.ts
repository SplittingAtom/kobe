import {
  ARG_PATTERN_MAX_ENTRIES,
  argPatternSchema,
  BUILTIN_TOOLS,
  canonicalJson,
  GLOB_MAX_LENGTH,
  REMEMBER_FIXED_SECONDS,
  resolveJsonPointer,
  scheduleTimezoneSchema,
  type ArgPattern,
  type JsonObject,
  type RememberScope,
  type ToolDescriptor,
} from "@kobe/protocol";
import { wallMs, wallToInstant } from "../schedules/recurrence.js";
import { matchArgPattern } from "./patterns.js";
import { prepareInput } from "./tool-inputs.js";

/**
 * Server-side pieces of a remembered approval (KOBE-289): its expiry and its "only this exact
 * action" pattern. Both come from server state only (the clock, the member's stored time zone, the
 * approval's stored canonical input), never from what the client sends.
 */

const DAY_MS = 86_400_000;

/** A stored time zone the server can use; anything else (or none) is UTC. */
export function usableTimeZone(tz: string | null | undefined): string {
  if (tz === null || tz === undefined) return "UTC";
  return scheduleTimezoneSchema.safeParse(tz).success ? tz : "UTC";
}

/** The next local midnight in `tz` after `now` (DST-aware: the first instant of the next day). */
export function endOfLocalDay(tz: string, now: Date): Date {
  const zone = usableTimeZone(tz);
  const wall = wallMs(zone, now.getTime());
  const nextMidnight = (Math.floor(wall / DAY_MS) + 1) * DAY_MS;
  return new Date(wallToInstant(zone, nextMidnight));
}

/**
 * When a remember-rule made `now` expires. `today` ends at the member's midnight; `day` and
 * `month` after their fixed lifetime; `thread`, `run` and `forever` have no time of their own (they
 * end with their thread or run, or when revoked). An admin's max duration caps every one.
 */
export function rememberExpiry(
  scope: RememberScope,
  now: Date,
  timeZone: string | null,
  maxDurationSeconds: number | null,
): Date | null {
  const fixed = REMEMBER_FIXED_SECONDS[scope];
  let end: number | null = null;
  if (scope === "today") end = endOfLocalDay(usableTimeZone(timeZone), now).getTime();
  else if (fixed !== undefined) end = now.getTime() + fixed * 1000;
  if (maxDurationSeconds !== null) {
    const cap = now.getTime() + maxDurationSeconds * 1000;
    end = end === null ? cap : Math.min(end, cap);
  }
  return end === null ? null : new Date(end);
}

/** `*`, `?` and `\` escaped: the glob matches exactly the text (protocol glob grammar). */
export function literalGlob(text: string): string {
  return text.replace(/[\\*?]/g, (ch) => `\\${ch}`);
}

/** RFC 6901 escaping of one object key. */
function pointerToken(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** What the exact pattern pins: the built-in's primary argument, else every top-level argument. */
function pinnedPointers(tool: ToolDescriptor, view: JsonObject): string[] {
  const builtin =
    tool.source !== "mcp" && Object.hasOwn(BUILTIN_TOOLS, tool.name)
      ? BUILTIN_TOOLS[tool.name]
      : undefined;
  if (builtin?.primary_arg !== undefined) return [builtin.primary_arg];
  return Object.keys(view)
    .sort()
    .map((k) => `/${pointerToken(k)}`);
}

/** The glob's subject for a value, as `matchArgPattern` sees it (a string, else canonical JSON). */
function subjectOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  try {
    return canonicalJson(value);
  } catch {
    return undefined;
  }
}

/**
 * "Only this exact action" (KOBE-289 ac-2): an argument pattern of literal globs over the approved
 * input as the engine sees it (`prepareInput`: validated, paths made canonical), so it matches
 * that action again and nothing else. A built-in pins its primary argument (the exact command for
 * `bash`, the exact path for file tools); other tools pin every top-level argument. Undefined
 * when no such pattern fits the grammar (no arguments, too many, or a value over 256 characters):
 * the choice is then not offered. The pattern is checked to match the input it came from.
 */
export function exactArgPattern(tool: ToolDescriptor, input: JsonObject): ArgPattern | undefined {
  const prepared = prepareInput(tool, input);
  if (!prepared.ok) return undefined;
  const pointers = pinnedPointers(tool, prepared.view);
  if (pointers.length === 0 || pointers.length > ARG_PATTERN_MAX_ENTRIES) return undefined;
  const pattern: Record<string, string> = {};
  for (const pointer of pointers) {
    const value = resolveJsonPointer(prepared.view, pointer);
    const subject = value === undefined ? undefined : subjectOf(value);
    if (subject === undefined || subject === "") return undefined;
    const glob = literalGlob(subject);
    if (glob.length > GLOB_MAX_LENGTH) return undefined;
    pattern[pointer] = glob;
  }
  const parsed = argPatternSchema.safeParse(pattern);
  if (!parsed.success) return undefined;
  return matchArgPattern(parsed.data, prepared.view, "loosen") ? parsed.data : undefined;
}
