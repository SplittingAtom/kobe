import { StringDecoder } from "node:string_decoder";
import type { RouteKind } from "../routes.js";
import { chargedOutput } from "./charge.js";
import { JsonUsageScanner, type FoundUsage } from "./json-scan.js";
import { usageOf, type PartialCounts, type TokenCounts } from "./normalize.js";

/**
 * Measures one forwarded model call's token usage from the upstream response as it streams to
 * the sandbox (KOBE-43). The response is never buffered:
 *
 * - **SSE** (every streaming API): events are decoded line by line (a line longer than
 *   `maxLineBytes` is skipped); the usage the provider reports in its events (OpenAI's final chunk
 *   with `stream_options.include_usage`, Responses' `response.completed`, Anthropic's
 *   `message_start` + `message_delta`, Gemini's `usageMetadata`) is merged, later fields winning.
 * - **JSON**: the top-level `usage` / `usageMetadata` value is captured by a structural scan.
 *
 * A call counts as **reported** only when the response completed and carried a final usage report.
 * Otherwise (stream cut short, a request that did not ask for usage, an unreadable encoding) the
 * counts are **estimated**: reported fields are kept, missing input is the request size / 4 and
 * missing output the generated text's length / 4 (the response size / 4 when the text cannot be
 * read). A sandbox therefore cannot make a call cheaper by suppressing the usage report.
 */
export interface UsageReading {
  readonly counts: TokenCounts;
  readonly source: "reported" | "estimated";
}

/** Keys whose string values are generated content (deltas and whole messages alike). */
const TEXT_KEYS = new Set([
  "content",
  "text",
  "partial_json",
  "thinking",
  "arguments",
  "reasoning",
  "reasoning_content",
  "refusal",
  "delta",
]);
const MAX_WALK_DEPTH = 12;
const CHARS_PER_TOKEN = 4;
/**
 * Longest SSE line decoded (characters). Provider stream events are a few KiB; the bound keeps a
 * replica's worst case (every concurrent call holding a full line) to tens of MiB.
 */
const MAX_LINE_CHARS = 32 * 1024;

function textChars(value: unknown, depth = 0): number {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== "object") return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const v of value) total += textChars(v, depth + 1);
    return total;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (TEXT_KEYS.has(k)) total += v.length;
    } else {
      total += textChars(v, depth + 1);
    }
  }
  return total;
}

const promptOf = (c: PartialCounts) => (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);

/**
 * Merges a later usage report into what a response reported so far. Provider counters only grow
 * within a response, so a report never lowers them: output keeps the larger count, and the prompt
 * side (input and its cache split) is replaced only by a report whose prompt total is not
 * smaller (Gemini adds the cache split in a later chunk; a translated Anthropic `message_delta`
 * may carry `input_tokens: 0`).
 */
export function mergeCounts(before: PartialCounts, report: PartialCounts): PartialCounts {
  const next: PartialCounts = { ...before };
  const prompt: PartialCounts = {};
  if (report.input !== undefined) prompt.input = report.input;
  if (report.cacheRead !== undefined) prompt.cacheRead = report.cacheRead;
  if (report.cacheWrite !== undefined) prompt.cacheWrite = report.cacheWrite;
  if (Object.keys(prompt).length > 0 && promptOf({ ...before, ...prompt }) >= promptOf(before)) {
    Object.assign(next, prompt);
  }
  if (report.output !== undefined) next.output = Math.max(before.output ?? 0, report.output);
  return next;
}

/** A captured usage value back in the shape its event had (for {@link usageOf}). */
function eventOf(found: FoundUsage): unknown {
  const member = { [found.key]: found.value };
  if (found.parent === "response") return { response: member };
  if (found.parent === "message") return { type: "message_start", message: member };
  return member;
}

export interface MeterOptions {
  readonly kind: RouteKind;
  readonly contentType: string | undefined;
  readonly contentEncoding: string | undefined;
  readonly maxLineBytes?: number;
}

export class UsageMeter {
  private readonly mode: "sse" | "json" | "opaque";
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLine: number;
  private line = "";
  private skippingLine = false;
  /** Scans a line too long to decode for its usage member (never drops a usage report). */
  private longLine: JsonUsageScanner | undefined;
  private readonly scanner: JsonUsageScanner | undefined;
  private merged: PartialCounts = {};
  private sawFinal = false;
  private chars = 0;
  private bytes = 0;

  constructor(private readonly options: MeterOptions) {
    const type = (options.contentType ?? "").toLowerCase();
    const encoded = options.contentEncoding && options.contentEncoding.toLowerCase() !== "identity";
    this.mode = encoded
      ? "opaque"
      : type.includes("text/event-stream")
        ? "sse"
        : type.includes("json")
          ? "json"
          : "opaque";
    this.scanner = this.mode === "json" ? new JsonUsageScanner() : undefined;
    this.maxLine = options.maxLineBytes ?? MAX_LINE_CHARS;
  }

  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.mode === "json") this.scanner?.write(chunk);
    else if (this.mode === "sse") this.sse(this.decoder.write(chunk));
  }

  /** The reading once the response ended (`complete`) or was cut short. */
  finish(complete: boolean, requestBytes: number, requestedOutput?: number): UsageReading {
    if (this.mode === "sse") this.sse(`${this.decoder.end()}\n`);
    if (this.mode === "json") {
      for (const found of this.scanner?.values ?? []) {
        this.take(usageOf(this.options.kind, eventOf(found)));
      }
    }
    const m = this.merged;
    if (complete && this.sawFinal) {
      return {
        source: "reported",
        counts: {
          input: m.input ?? 0,
          output: m.output ?? 0,
          cacheRead: m.cacheRead ?? 0,
          cacheWrite: m.cacheWrite ?? 0,
        },
      };
    }
    const generated = this.mode === "sse" ? this.chars : this.bytes;
    const promptKnown =
      m.input !== undefined || m.cacheRead !== undefined || m.cacheWrite !== undefined;
    return {
      source: "estimated",
      counts: {
        input: promptKnown ? (m.input ?? 0) : Math.ceil(requestBytes / CHARS_PER_TOKEN),
        output: Math.max(
          m.output ?? 0,
          Math.ceil(generated / CHARS_PER_TOKEN),
          chargedOutput(requestedOutput),
        ),
        cacheRead: m.cacheRead ?? 0,
        cacheWrite: m.cacheWrite ?? 0,
      },
    };
  }

  private take(found: ReturnType<typeof usageOf>): void {
    if (!found) return;
    this.merged = mergeCounts(this.merged, found.counts);
    if (found.final) this.sawFinal = true;
  }

  private sse(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) {
        this.append(text.slice(start));
        return;
      }
      this.append(text.slice(start, nl));
      if (!this.skippingLine) this.event(this.line);
      else this.endLongLine();
      this.line = "";
      this.skippingLine = false;
      start = nl + 1;
    }
  }

  private append(part: string): void {
    if (this.skippingLine) {
      this.chars += part.length;
      this.longLine?.write(Buffer.from(part, "utf8"));
      return;
    }
    if (this.line.length + part.length > this.maxLine) {
      // Too long to decode whole: count it as generated text and scan it for its usage member.
      const head = this.line + part;
      this.chars += head.length;
      this.line = "";
      this.skippingLine = true;
      this.longLine = head.startsWith("data:") ? new JsonUsageScanner() : undefined;
      this.longLine?.write(Buffer.from(head.slice(5), "utf8"));
      return;
    }
    this.line += part;
  }

  private endLongLine(): void {
    for (const found of this.longLine?.values ?? []) {
      this.take(usageOf(this.options.kind, eventOf(found)));
    }
    this.longLine = undefined;
  }

  private event(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.chars += data.length;
      return;
    }
    this.chars += textChars(value);
    this.take(usageOf(this.options.kind, value));
  }
}
