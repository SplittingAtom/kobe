/**
 * Run latencies as spans (KOBE-525), timed where the server sees them (frame arrival), so the
 * gate1 trace backend answers "how long until the agent answers" without a metrics SDK:
 *
 * - `run.pi_ready`: run.start delivered → the run's first Pi frame (Pi spawned and talking).
 * - `run.first_token`: run.start delivered → the first text or reasoning delta.
 * - `run.tool_call`: a tool call's start → its result (includes the server's policy decision).
 *
 * Each span's duration is the latency, so percentiles need only span names and times. Attributes
 * are low-cardinality on purpose (kind, tool name, error flag; never ids or content). A resumed
 * run (its start went out on an earlier connection) records only tool calls.
 */
export type LatencySpanName = "run.pi_ready" | "run.first_token" | "run.tool_call";

export interface LatencySpan {
  readonly name: LatencySpanName;
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Readonly<Record<string, string | boolean>>;
}

export interface RunLatencyOptions {
  /** When run.start was handed to this connection (epoch ms). */
  readonly startMs: number;
  /** The run was leased with a cursor > 0: its start is not this connection's. */
  readonly resumed: boolean;
  readonly compaction: boolean;
  readonly emit: (span: LatencySpan) => void;
  /** Open tool calls remembered at most (a run that never reports results stays bounded). */
  readonly maxOpenTools?: number;
}

export interface ObservedEvent {
  readonly type: string;
  readonly payload: unknown;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const DEFAULT_MAX_OPEN_TOOLS = 256;

/** A tool name as a span attribute: plain names as they are, anything else as `other`. */
export function toolNameAttribute(name: unknown): string {
  return typeof name === "string" && TOOL_NAME.test(name) ? name : "other";
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export class RunLatency {
  readonly #o: RunLatencyOptions;
  readonly #kind: string;
  readonly #maxOpen: number;
  readonly #open = new Map<string, { readonly startMs: number; readonly tool: string }>();
  #sawFrame: boolean;
  #sawToken: boolean;

  constructor(options: RunLatencyOptions) {
    this.#o = options;
    this.#kind = options.compaction ? "compaction" : "run";
    this.#maxOpen = options.maxOpenTools ?? DEFAULT_MAX_OPEN_TOOLS;
    this.#sawFrame = options.resumed;
    this.#sawToken = options.resumed;
  }

  /** One translated Pi frame's events, at `nowMs` (frame order). */
  observe(events: readonly ObservedEvent[], nowMs: number): void {
    if (!this.#sawFrame) {
      this.#sawFrame = true;
      this.#emit("run.pi_ready", this.#o.startMs, nowMs, {});
    }
    for (const event of events) this.#event(event, nowMs);
  }

  #event(event: ObservedEvent, nowMs: number): void {
    if (event.type === "text.delta" || event.type === "reasoning.delta") {
      if (this.#sawToken) return;
      this.#sawToken = true;
      this.#emit("run.first_token", this.#o.startMs, nowMs, {
        "kobe.token.kind": event.type === "text.delta" ? "text" : "reasoning",
      });
      return;
    }
    const id = field(event.payload, "tool_call_id");
    if (typeof id !== "string") return;
    if (event.type === "tool.call") {
      if (this.#open.size >= this.#maxOpen) return;
      this.#open.set(id, { startMs: nowMs, tool: toolNameAttribute(field(event.payload, "tool")) });
    } else if (event.type === "tool.result") {
      const open = this.#open.get(id);
      if (!open) return;
      this.#open.delete(id);
      this.#emit("run.tool_call", open.startMs, nowMs, {
        "kobe.tool.name": open.tool,
        "kobe.tool.error": field(event.payload, "is_error") === true,
      });
    }
  }

  #emit(
    name: LatencySpanName,
    startMs: number,
    endMs: number,
    extra: Readonly<Record<string, string | boolean>>,
  ): void {
    this.#o.emit({
      name,
      startMs,
      endMs: Math.max(startMs, endMs),
      attributes: { "kobe.run.kind": this.#kind, ...extra },
    });
  }
}
