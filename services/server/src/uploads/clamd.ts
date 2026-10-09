import { connect } from "node:net";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { logger } from "../logger.js";
import type { ObjectStore } from "../workspace-sync/object-store.js";
import type { UploadScanner } from "./store.js";

/**
 * Minimal clamd client (KOBE-146, optional upload scanning, spec D26): the INSTREAM command over
 * TCP. The upload's bytes are streamed from the object store to clamd, never held in memory and
 * never written to disk by the server.
 *
 * Fail closed: anything but a clean `OK` or a `FOUND` verdict (connection refused, timeout, a
 * clamd `ERROR` such as the stream size limit, an unreadable reply, a failing source stream) is
 * `unavailable`; the caller refuses the upload with `scan_unavailable`.
 */

export interface ClamdOptions {
  readonly host: string;
  readonly port: number;
  /** Idle timeout of the connection (no bytes either way for this long = unavailable). */
  readonly timeoutMs: number;
}

export type ScanVerdict =
  | { readonly result: "clean" }
  | { readonly result: "infected"; readonly signature: string }
  | { readonly result: "unavailable"; readonly reason: string };

/** Largest INSTREAM chunk sent (clamd accepts up to StreamMaxLength per command in total). */
const CHUNK_BYTES = 64 * 1024;

/** Frames bytes as INSTREAM chunks: 4-byte big-endian length, then the data; 0 length ends. */
class InstreamFramer extends Transform {
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    for (let at = 0; at < chunk.length; at += CHUNK_BYTES) {
      const part = chunk.subarray(at, at + CHUNK_BYTES);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(part.length, 0);
      this.push(head);
      this.push(part);
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    this.push(Buffer.alloc(4));
    done();
  }
}

const unavailable = (reason: string): ScanVerdict => ({ result: "unavailable", reason });

function parseReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0+$/, "").trim();
  if (/^stream: OK$/.test(text)) return { result: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1]) return { result: "infected", signature: found[1] };
  return unavailable(`unexpected clamd reply: ${text.slice(0, 80)}`);
}

export function scanStream(options: ClamdOptions, body: Readable): Promise<ScanVerdict> {
  return new Promise((resolve) => {
    const socket = connect({ host: options.host, port: options.port });
    const framer = new InstreamFramer();
    const reply: Buffer[] = [];
    let settled = false;
    const finish = (verdict: ScanVerdict): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      framer.destroy();
      body.destroy();
      resolve(verdict);
    };
    socket.setTimeout(options.timeoutMs, () => finish(unavailable("clamd timed out")));
    // A write error (clamd closed early after an ERROR) is reported by the reply, if any.
    socket.on("error", (err) => finish(unavailable(`clamd connection failed: ${err.message}`)));
    body.on("error", (err) => finish(unavailable(`source stream failed: ${err.message}`)));
    framer.on("error", (err) => finish(unavailable(err.message)));
    socket.on("data", (data: Buffer) => reply.push(data));
    socket.on("close", () => {
      const text = Buffer.concat(reply).toString("utf8");
      finish(text === "" ? unavailable("clamd closed without a reply") : parseReply(text));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      body.pipe(framer).pipe(socket, { end: false });
    });
  });
}

/** An {@link UploadScanner} that streams the stored object to clamd. */
export function createClamdScanner(options: ClamdOptions, objects: ObjectStore): UploadScanner {
  return async ({ key }) => {
    try {
      const object = await objects.get(key);
      if (!object) return "unavailable";
      const verdict = await scanStream(options, object.body);
      if (verdict.result === "unavailable") {
        logger.warn({ reason: verdict.reason }, "upload scan unavailable");
        return "unavailable";
      }
      if (verdict.result === "infected") {
        // The signature name is not content; it helps an admin judge a false positive.
        logger.info({ signature: verdict.signature }, "upload rejected by the virus scan");
        return "rejected";
      }
      return "clean";
    } catch (err) {
      logger.warn({ err }, "upload scan failed");
      return "unavailable";
    }
  };
}
