/**
 * Finds the usage object of a JSON response body as it streams past (KOBE-43), without keeping
 * the body: a structural scan (strings, escapes and nesting tracked) that captures only the value
 * of a `usage` / `usageMetadata` member of the top-level object, or of an object directly inside a
 * top-level array (Gemini's non-SSE `streamGenerateContent` answers an array of chunks). A key of
 * that name inside model output (a string) or deeper in the structure never counts. Memory is
 * bounded by `maxValueBytes` per captured value.
 */
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_OBJ = 0x7b;
const CLOSE_OBJ = 0x7d;
const OPEN_ARR = 0x5b;
const CLOSE_ARR = 0x5d;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const USAGE_KEYS = new Set(["usage", "usageMetadata"]);
const MAX_KEY = 16;

export class JsonUsageScanner {
  /** Container kinds from the root down: true = object. */
  private readonly stack: boolean[] = [];
  private inString = false;
  private escaped = false;
  /** In an object, the next string is a key. */
  private expectKey = false;
  private key: number[] | undefined;
  private lastKey = "";
  /** After a usage key's colon: capture the value starting at the next non-space byte. */
  private armed = false;
  private capture: number[] | undefined;
  private captureDepth = 0;
  private overflow = false;
  private readonly found: unknown[] = [];

  constructor(private readonly maxValueBytes = 64 * 1024) {}

  /** Usage values seen so far, in order. */
  get values(): readonly unknown[] {
    return this.found;
  }

  write(chunk: Uint8Array): void {
    for (const c of chunk) this.byte(c);
  }

  private memberDepth(): boolean {
    const d = this.stack.length;
    if (d === 1) return this.stack[0] === true;
    return d === 2 && this.stack[0] === false && this.stack[1] === true;
  }

  private byte(c: number): void {
    if (this.capture) this.captureByte(c);
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === BACKSLASH) this.escaped = true;
      else if (c === QUOTE) {
        this.inString = false;
        if (this.key) {
          this.lastKey = String.fromCharCode(...this.key);
          this.key = undefined;
        }
        return;
      }
      if (this.key) {
        if (this.key.length < MAX_KEY) this.key.push(c);
        else this.key = [];
      }
      return;
    }
    if (WS.has(c)) return;
    if (this.armed) {
      this.armed = false;
      this.capture = [c];
      this.captureDepth = this.stack.length;
      this.overflow = false;
    }
    switch (c) {
      case QUOTE:
        this.inString = true;
        this.key = this.expectKey && this.memberDepth() ? [] : undefined;
        this.expectKey = false;
        return;
      case COLON:
        if (this.memberDepth() && USAGE_KEYS.has(this.lastKey)) this.armed = true;
        this.lastKey = "";
        return;
      case COMMA:
        this.expectKey = this.stack.at(-1) === true;
        this.endPrimitiveCapture();
        return;
      case OPEN_OBJ:
      case OPEN_ARR:
        this.stack.push(c === OPEN_OBJ);
        this.expectKey = c === OPEN_OBJ;
        return;
      case CLOSE_OBJ:
      case CLOSE_ARR:
        this.endPrimitiveCapture();
        this.stack.pop();
        this.expectKey = false;
        if (this.capture && this.stack.length === this.captureDepth) this.finishCapture();
        return;
      default:
        return;
    }
  }

  private captureByte(c: number): void {
    if (!this.capture) return;
    if (this.capture.length >= this.maxValueBytes) this.overflow = true;
    else this.capture.push(c);
  }

  /** A primitive value (e.g. `null`) ends at the member's comma or its object's close. */
  private endPrimitiveCapture(): void {
    if (!this.capture || this.stack.length !== this.captureDepth) return;
    this.capture.pop(); // the delimiter itself
    this.finishCapture();
  }

  private finishCapture(): void {
    const bytes = this.capture;
    this.capture = undefined;
    if (!bytes || this.overflow) return;
    try {
      this.found.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch {
      // Not valid JSON on its own (should not happen for a well-formed body): ignore.
    }
  }
}
