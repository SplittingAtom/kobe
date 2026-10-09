import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";

/** Longest captured value; spans are not a message store. */
export const MAX_CAPTURED_CHARS = 4096;

/**
 * Attribute keys that can carry content, secrets or user-chosen text. They are exported only when
 * content capture is on, whatever a call site records (defence in depth behind
 * {@link contentAttributes}). Token counts (`gen_ai.usage.*`) and sizes are metadata and pass.
 */
const CONTENT_KEY =
  /^(gen_ai\.(prompt|completion|input|output)(\.|$)|gen_ai\.(system_instructions|tool\.(call\.)?(arguments|result)).*|url\.(query|full)|http\.(request|response)\.(header|body)(\.(?!size$).*)?|kobe\.(message|tool\.(input|output)|content).*|db\.query\.text)$/;

export function isContentKey(key: string): boolean {
  return CONTENT_KEY.test(key);
}

function truncate(value: AttributeValue): AttributeValue {
  return typeof value === "string" && value.length > MAX_CAPTURED_CHARS
    ? `${value.slice(0, MAX_CAPTURED_CHARS)}…`
    : value;
}

/** Returns a copy of the attributes fit to export: content keys dropped or truncated. */
export function filterAttributes(attributes: Attributes, captureContent: boolean): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (!isContentKey(key)) out[key] = value;
    else if (captureContent) out[key] = truncate(value);
  }
  return out;
}

/** Wraps an exporter so no span leaves the process with content unless capture is on. */
export class ContentGuardExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly captureContent: boolean,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(
      spans.map((span) =>
        Object.create(span, {
          attributes: { value: filterAttributes(span.attributes, this.captureContent) },
        }),
      ) as ReadableSpan[],
      done,
    );
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
