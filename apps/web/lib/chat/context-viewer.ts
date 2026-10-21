/**
 * The context viewer (KOBE-471, docs/specs/context-viewer.md): reads `GET /v1/threads/{id}/context`
 * (KOBE-470) and shapes it for the panel: the stacked gauge by kind, the text as windowed rows,
 * search. The body is validated against `@kobe/protocol` as sent (wire casing, no camelizing);
 * every section text is untrusted and is only ever rendered as plain text.
 */
import {
  THREAD_CONTEXT_ERROR_MESSAGES,
  threadContextErrorCodeSchema,
  threadContextSchema,
  threadContextWakingSchema,
  type ContextSection,
  type ContextSectionKind,
  type ThreadContext,
  type ThreadContextErrorCode,
} from "@kobe/protocol";
import "../security/zod-jitless";
import { TEAM_HEADER } from "../teams";

export type ContextRead =
  | { readonly kind: "ready"; readonly context: ThreadContext }
  | { readonly kind: "waking"; readonly retryAfterMs: number }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      /** Asking again would not help (the viewer offers no retry). */
      readonly terminal: boolean;
    };

/** Codes after which the viewer stops asking (CV7): reading again gives the same answer. */
const TERMINAL_CODES: ReadonlySet<ThreadContextErrorCode> = new Set([
  "not_owner",
  "context_unsupported",
  "sandbox_refused",
]);

const fail = (code: string, message: string, terminal: boolean): ContextRead => ({
  kind: "error",
  code,
  message,
  terminal,
});

function failureOf(status: number, body: unknown): ContextRead {
  // Only the code is read: the message shown is the contract's own for it, never the body's.
  const known = threadContextErrorCodeSchema.safeParse(
    body !== null && typeof body === "object" ? (body as { code?: unknown }).code : undefined,
  );
  if (known.success) {
    const code = known.data;
    return fail(code, THREAD_CONTEXT_ERROR_MESSAGES[code], TERMINAL_CODES.has(code));
  }
  if (status === 401)
    return fail("unauthenticated", "Your session has ended. Sign in again.", true);
  if (status === 404) {
    return fail("thread_not_found", "This conversation no longer exists.", true);
  }
  if (status === 403) {
    return fail("forbidden", THREAD_CONTEXT_ERROR_MESSAGES.not_owner, true);
  }
  return fail(
    "context_unavailable",
    `The context could not be read (HTTP ${status}). Try again.`,
    false,
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** One read of the route. Never throws: a failure is a `ContextRead` error. */
export async function readThreadContext(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ContextRead> {
  let res: Response;
  try {
    res = await fetchFn(`/v1/threads/${encodeURIComponent(threadId)}/context`, {
      method: "GET",
      headers: { accept: "application/json", [TEAM_HEADER]: teamId },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return fail(
      "network_error",
      "Kobe is unreachable. Check your connection and try again.",
      false,
    );
  }
  const body = await readJson(res);
  if (res.status === 202) {
    const waking = threadContextWakingSchema.safeParse(body);
    if (waking.success) return { kind: "waking", retryAfterMs: waking.data.retry_after_ms };
  }
  if (res.status === 200) {
    const ready = threadContextSchema.safeParse(body);
    if (ready.success) return { kind: "ready", context: ready.data };
    return fail("context_unavailable", THREAD_CONTEXT_ERROR_MESSAGES.context_unavailable, false);
  }
  return failureOf(res.status, body);
}

/** Never ask faster than this while the workspace wakes (the route allows 30 reads a minute). */
export const WAKE_FLOOR_MS = 2_000;
export const WAKE_CAP_MS = 10_000;
/** Past this the viewer stops asking and offers Refresh. */
export const WAKE_GIVE_UP_MS = 180_000;

/** The wait before the next read while waking: the server's hint, backed off ×1.5, capped. */
export function nextWakeDelay(attempt: number, retryAfterMs: number): number {
  const base = Math.max(retryAfterMs, WAKE_FLOOR_MS);
  return Math.min(Math.round(base * 1.5 ** attempt), WAKE_CAP_MS);
}

/** The gauge's kinds, bottom up in the order the model saw them; tool calls and results share one. */
export const GAUGE_KINDS = [
  "system_prompt",
  "agent_instructions",
  "skills",
  "memory",
  "viewing_file",
  "tool_definitions",
  "user_message",
  "assistant_message",
  "tools",
  "compaction_summary",
  "other",
] as const;
export type GaugeKind = (typeof GAUGE_KINDS)[number];

export const GAUGE_LABELS: Readonly<Record<GaugeKind, string>> = {
  system_prompt: "System prompt",
  agent_instructions: "Agent instructions",
  skills: "Skills",
  memory: "Memory",
  viewing_file: "Viewed file",
  tool_definitions: "Tool definitions",
  user_message: "User prompts",
  assistant_message: "Assistant replies",
  tools: "Tool calls and results",
  compaction_summary: "Compaction summary",
  other: "Other",
};

/** One section's kind, as its label in the text. */
export const SECTION_LABELS: Readonly<Record<ContextSectionKind, string>> = {
  system_prompt: "System prompt",
  agent_instructions: "Agent instructions",
  skills: "Skills",
  memory: "Memory",
  viewing_file: "Viewed file",
  tool_definitions: "Tool definition",
  user_message: "User prompt",
  assistant_message: "Assistant reply",
  tool_call: "Tool call",
  tool_result: "Tool result",
  compaction_summary: "Compaction summary",
  other: "Other",
};

export function gaugeKindOf(kind: ContextSectionKind): GaugeKind {
  return kind === "tool_call" || kind === "tool_result" ? "tools" : kind;
}

export interface GaugeSlice {
  readonly kind: GaugeKind;
  readonly tokens: number;
  /** Its part of the gauge's height, 0..1. */
  readonly share: number;
  /** Its part of the context window (or of the total without one), 0..1, for the legend. */
  readonly ofWindow: number;
  /** The first section of this kind (where a click scrolls to). */
  readonly firstSection: number;
}

export interface GaugeModel {
  readonly slices: readonly GaugeSlice[];
  /** The window the gauge is drawn against; null when unknown (then the gauge is all used). */
  readonly window: number | null;
  readonly total: number;
  readonly free: number;
  readonly freeShare: number;
  /** The context is larger than the window (a model change since, or a smaller window). */
  readonly over: boolean;
}

/** The stacked gauge: tokens per kind against the call's window (else the gauge's, else the total). */
export function gaugeModel(context: ThreadContext, fallbackWindow: number | null): GaugeModel {
  const sums = new Map<GaugeKind, { tokens: number; first: number }>();
  context.sections.forEach((s, i) => {
    const kind = gaugeKindOf(s.kind);
    const was = sums.get(kind);
    sums.set(kind, { tokens: (was?.tokens ?? 0) + s.tokens, first: was?.first ?? i });
  });
  const total = [...sums.values()].reduce((n, v) => n + v.tokens, 0);
  const window = context.context_window ?? fallbackWindow;
  const scale = Math.max(window ?? 0, total, 1);
  const basis = Math.max(window ?? total, 1);
  const slices = GAUGE_KINDS.flatMap((kind) => {
    const sum = sums.get(kind);
    if (sum === undefined) return [];
    return [
      {
        kind,
        tokens: sum.tokens,
        share: sum.tokens / scale,
        ofWindow: sum.tokens / basis,
        firstSection: sum.first,
      },
    ];
  });
  const free = window === null ? 0 : Math.max(window - total, 0);
  return {
    slices,
    window,
    total,
    free,
    freeShare: free / scale,
    over: window !== null && total > window,
  };
}

/** Text lines longer than this are wrapped onto the next rows (rows have one fixed height). */
export const WRAP_COLUMNS = 160;

export type TextRow =
  | { readonly type: "label"; readonly section: number }
  | { readonly type: "line"; readonly section: number; readonly text: string };

/** The text as rows: a label row per section, then its lines, long lines wrapped. */
export function buildRows(sections: readonly ContextSection[]): {
  readonly rows: readonly TextRow[];
  /** Each section's label row. */
  readonly firstRow: readonly number[];
} {
  const rows: TextRow[] = [];
  const firstRow: number[] = [];
  sections.forEach((s, section) => {
    firstRow.push(rows.length);
    rows.push({ type: "label", section });
    for (const line of s.text.split("\n")) {
      if (line.length <= WRAP_COLUMNS) {
        rows.push({ type: "line", section, text: line });
        continue;
      }
      for (let at = 0; at < line.length; at += WRAP_COLUMNS) {
        rows.push({ type: "line", section, text: line.slice(at, at + WRAP_COLUMNS) });
      }
    }
  });
  return { rows, firstRow };
}

/** At most this many matches are listed. */
export const MAX_MATCHES = 10_000;

/** The text rows that contain `query`, ignoring case (a match across a wrap is not found). */
export function findMatches(rows: readonly TextRow[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const found: number[] = [];
  for (let i = 0; i < rows.length && found.length < MAX_MATCHES; i++) {
    const row = rows[i];
    if (row?.type === "line" && row.text.toLowerCase().includes(q)) found.push(i);
  }
  return found;
}

/** Rows rendered above and below the viewport. */
export const OVERSCAN_ROWS = 20;

/** The rows `[start, end)` to render for this scroll position. */
export function visibleRange({
  scrollTop,
  viewport,
  rowPx,
  count,
}: {
  readonly scrollTop: number;
  readonly viewport: number;
  readonly rowPx: number;
  readonly count: number;
}): readonly [number, number] {
  const first = Math.floor(scrollTop / rowPx);
  const shown = Math.ceil(viewport / rowPx);
  return [Math.max(0, first - OVERSCAN_ROWS), Math.min(count, first + shown + OVERSCAN_ROWS)];
}

/** A share as the legend shows it: whole percent, one decimal under 10%, "<0.1%" for a sliver. */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct)}%`;
}

const MISSING_LABELS: Readonly<Record<ThreadContext["missing"][number], string>> = {
  memory: "memory",
  project_instructions: "project instructions",
  viewing_file: "the viewed file",
  context_window: "the context window",
  older_history: "older history",
};

/** The notice of an approximate answer (CV4); null when exact. */
export function approximateNotice(context: ThreadContext): string | null {
  if (context.exact) return null;
  const parts = context.missing.map((m) => MISSING_LABELS[m]);
  const lead = "Approximate — the sandbox restarted since the last model call.";
  return parts.length === 0 ? lead : `${lead} May lack: ${parts.join(", ")}.`;
}
