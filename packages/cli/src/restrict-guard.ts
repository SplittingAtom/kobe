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
  private key: string | null = null;
  private tail = "";

  /** Feeds a chunk; returns what may be forwarded now (nothing until the head is verified). */
  push(chunk: Buffer): Buffer[] {
    this.tail = (this.tail + chunk.toString("latin1")).slice(-TAIL_BYTES);
    if (this.key !== null) return [chunk];
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    const text = Buffer.concat(this.held).toString("utf8");
    const lines = text.split("\n");
    lines.pop(); // the last element is an incomplete line (or "")
    const first = lines.find((l) => !isCommentOrBlank(l));
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
