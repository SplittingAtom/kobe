/**
 * Defence in depth around pg_restore's script: psql only ever sees a script whose first command is
 * `\restrict <key>` (so meta-commands such as `\!` are refused for the rest of it) and whose last
 * command is the matching `\unrestrict <key>`. Output is held back until the head is verified;
 * the tail is checked before the caller appends the COMMIT.
 */
const MAX_HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 8 * 1024;

const isCommentOrBlank = (line: string): boolean => line.trim() === "" || line.startsWith("--");

export class RestrictGuard {
  private held: Buffer[] = [];
  private heldBytes = 0;
  /** Bytes after the last newline seen: the start of a line not yet scanned. */
  private partial: Buffer[] = [];
  private key: string | null = null;
  private tail = "";

  /** Feeds a chunk; returns what may be forwarded now (nothing until the head is verified). */
  push(chunk: Buffer): Buffer[] {
    this.tail = (this.tail + chunk.toString("latin1")).slice(-TAIL_BYTES);
    if (this.key !== null) return [chunk];
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    const first = this.firstCommandIn(chunk);
    if (first === undefined) {
      if (this.heldBytes > MAX_HEAD_BYTES) throw notRestricted();
      return [];
    }
    const match = /^\\restrict (\S+)$/.exec(first);
    if (!match?.[1]) throw notRestricted();
    this.key = match[1];
    const out = this.held;
    this.held = [];
    return out;
  }

  /**
   * The first complete line in `chunk` (with the unscanned start of its first line) that is not a
   * comment or blank. Only new lines are scanned: everything before was comments or blank, so the
   * head check stays linear in the bytes held. A newline byte never occurs inside a UTF-8
   * sequence, so splitting on it before decoding is safe.
   */
  private firstCommandIn(chunk: Buffer): string | undefined {
    const end = chunk.lastIndexOf(0x0a);
    if (end === -1) {
      this.partial.push(chunk);
      return undefined;
    }
    const complete = Buffer.concat([...this.partial, chunk.subarray(0, end)]);
    this.partial = [chunk.subarray(end + 1)];
    return complete
      .toString("utf8")
      .split("\n")
      .find((l) => !isCommentOrBlank(l));
  }

  /** Call at end of stream; throws unless the script ended with `\unrestrict <same key>`. */
  finish(): Buffer[] {
    if (this.key === null) throw notRestricted();
    const last = this.tail
      .split("\n")
      .filter((l) => !isCommentOrBlank(l))
      .at(-1);
    if (last !== `\\unrestrict ${this.key}`) {
      throw new Error(
        "The pg_restore script does not end with the matching \\unrestrict; refusing to commit",
      );
    }
    return [];
  }
}

function notRestricted(): Error {
  return new Error(
    "The pg_restore script does not start with \\restrict; refusing to run it (PostgreSQL client 17.6+ required)",
  );
}
