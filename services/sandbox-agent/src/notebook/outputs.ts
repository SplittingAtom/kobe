import {
  NOTEBOOK_EXEC_OUTPUT_MAX_BYTES,
  NOTEBOOK_EXEC_OUTPUTS_MAX,
  NOTEBOOK_MIME_TYPES,
  NOTEBOOK_OUTPUT_MAX_BYTES,
  NOTEBOOK_TRUNCATED_PREFIX,
  notebookOutputSchema,
  type NotebookOutput,
} from "@kobe/protocol";

/**
 * Kobe's caps on what a kernel prints (docs/specs/notebooks.md NB4, NB9), applied before anything
 * is sent: the MIME allow-list, at most `maxOutputBytes` per output, `maxOutputs` and `maxBytes`
 * per execution, and stream text coalesced (per stream name, up to `coalesceBytes`, flushed after
 * `flushMs`). Past a cap one marker output ends the outputs and the rest is dropped.
 */
export interface OutputLimits {
  readonly maxOutputs: number;
  readonly maxBytes: number;
  readonly maxOutputBytes: number;
  readonly coalesceBytes: number;
  readonly flushMs: number;
}

export const OUTPUT_LIMITS: OutputLimits = {
  maxOutputs: NOTEBOOK_EXEC_OUTPUTS_MAX,
  maxBytes: NOTEBOOK_EXEC_OUTPUT_MAX_BYTES,
  maxOutputBytes: NOTEBOOK_OUTPUT_MAX_BYTES,
  coalesceBytes: 32 * 1024,
  flushMs: 100,
};

const MIME = new Set<string>(NOTEBOOK_MIME_TYPES);
const TEXT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/latex",
  "text/html",
  "image/svg+xml",
]);
const MAX_TRACEBACK_LINES = 1000;

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const clean = (s: string): string => s.replaceAll("\u0000", "�");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** nbformat allows multi-line strings as arrays of lines. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return clean(value.join(""));
  }
  return undefined;
}

export function noteOutput(text: string): NotebookOutput {
  return { output_type: "stream", name: "stderr", text };
}

/** The allow-listed part of a MIME bundle (text as strings); undefined when nothing is left. */
function bundleOf(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries(data)) {
    if (!MIME.has(mime)) continue;
    if (mime === "application/json") kept[mime] = value;
    else if (TEXT_MIME.has(mime)) {
      const text = textOf(value);
      if (text !== undefined) kept[mime] = text;
    } else if (typeof value === "string") kept[mime] = value.replaceAll(/\s/g, "");
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** A kernel output as Kobe keeps it, or undefined when nothing of it may be shown. */
export function sanitizeOutput(raw: unknown): NotebookOutput | undefined {
  if (!isRecord(raw)) return undefined;
  const type = raw.output_type;
  let out: unknown;
  if (type === "stream") {
    const text = textOf(raw.text);
    if (text === undefined || text === "") return undefined;
    out = { output_type: "stream", name: raw.name === "stderr" ? "stderr" : "stdout", text };
  } else if (type === "error") {
    const traceback = Array.isArray(raw.traceback)
      ? raw.traceback.filter((l): l is string => typeof l === "string").map(clean)
      : [];
    out = {
      output_type: "error",
      ename: clean(String(raw.ename ?? "")).slice(0, 256),
      evalue: clean(String(raw.evalue ?? "")),
      traceback: traceback.slice(-MAX_TRACEBACK_LINES),
    };
  } else if (type === "display_data" || type === "execute_result") {
    const data = bundleOf(raw.data);
    if (data === undefined) return undefined;
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    out =
      type === "display_data"
        ? { output_type: type, data, metadata }
        : {
            output_type: type,
            execution_count:
              typeof raw.execution_count === "number" && Number.isInteger(raw.execution_count)
                ? raw.execution_count
                : null,
            data,
            metadata,
          };
  } else {
    return undefined;
  }
  return out as NotebookOutput;
}

/** An output over the per-output cap, made to fit: rich data dropped, traceback and text cut. */
function shrink(output: NotebookOutput, max: number): NotebookOutput {
  const size = bytesOf(output);
  if (size <= max) return output;
  if (output.output_type === "display_data" || output.output_type === "execute_result") {
    const plain = output.data["text/plain"];
    const note = `${NOTEBOOK_TRUNCATED_PREFIX}: an output of ${size} bytes is over the ${max}-byte limit]\n`;
    if (typeof plain === "string" && bytesOf(plain) < max / 2) {
      return noteOutput(`${note}${plain}\n`);
    }
    return noteOutput(note);
  }
  if (output.output_type === "error") {
    const cut = { ...output, evalue: output.evalue.slice(0, 4096), traceback: [] as string[] };
    for (const line of [...output.traceback].reverse()) {
      if (bytesOf(cut) + bytesOf(line) > max - 1024) break;
      cut.traceback.unshift(line);
    }
    return cut;
  }
  return { ...output, text: cutUtf8(output.text, max - 1024) };
}

function cutUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�$/u, "");
}

/**
 * One execution's outputs on their way to the server. `emit` gets each output with its index, in
 * order; `finish` flushes and says how many went out and whether a cap cut them.
 */
export class OutputLimiter {
  readonly #limits: OutputLimits;
  readonly #emit: (index: number, output: NotebookOutput) => void;
  #count = 0;
  #bytes = 0;
  #truncated = false;
  #pending: { name: "stdout" | "stderr"; text: string } | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    emit: (index: number, output: NotebookOutput) => void,
    limits: OutputLimits = OUTPUT_LIMITS,
  ) {
    this.#emit = emit;
    this.#limits = limits;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  /** Any raw kernel output (sanitized here; anything not allowed is dropped). */
  push(raw: unknown): void {
    const output = sanitizeOutput(raw);
    if (output === undefined || this.#truncated) return;
    if (output.output_type === "stream") {
      this.#appendStream(output.name, output.text);
      return;
    }
    this.flush();
    this.#send(shrink(output, this.#limits.maxOutputBytes));
  }

  /** Sends buffered stream text now. */
  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined && pending.text !== "") {
      this.#send({ output_type: "stream", name: pending.name, text: pending.text });
    }
  }

  /** The kernel is done (or gone): flush and report. */
  finish(): { readonly outputs: number; readonly truncated: boolean } {
    this.flush();
    return { outputs: this.#count, truncated: this.#truncated };
  }

  /** A note of Kobe's own (the kernel died, the timeout), subject to the same caps. */
  note(text: string): void {
    this.flush();
    if (!this.#truncated) this.#send(noteOutput(text));
  }

  #appendStream(name: "stdout" | "stderr", text: string): void {
    if (this.#pending !== undefined && this.#pending.name !== name) this.flush();
    let rest = (this.#pending?.text ?? "") + text;
    this.#pending = undefined;
    const chunk = this.#limits.coalesceBytes;
    while (Buffer.byteLength(rest) >= chunk && !this.#truncated) {
      const head = cutUtf8(rest, chunk);
      rest = rest.slice(head.length);
      this.#send({ output_type: "stream", name, text: head });
    }
    if (this.#truncated || rest === "") return;
    this.#pending = { name, text: rest };
    this.#timer ??= setTimeout(() => this.flush(), this.#limits.flushMs);
  }

  #send(output: NotebookOutput): void {
    if (this.#truncated) return;
    const size = bytesOf(output);
    const last = this.#count >= this.#limits.maxOutputs - 1;
    if (last || this.#bytes + size > this.#limits.maxBytes - 1024) {
      this.#truncated = true;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#pending = undefined;
      this.#deliver(
        noteOutput(
          `${NOTEBOOK_TRUNCATED_PREFIX}: this cell printed more than Kobe keeps (${this.#limits.maxOutputs} outputs, ${this.#limits.maxBytes} bytes)]\n`,
        ),
      );
      return;
    }
    this.#deliver(output);
  }

  #deliver(output: NotebookOutput): void {
    if (!notebookOutputSchema.safeParse(output).success) return;
    this.#bytes += bytesOf(output);
    this.#emit(this.#count, output);
    this.#count += 1;
  }
}
