import { Zip, ZipDeflate } from "fflate";

/** One file of an export: a validated relative path and its bytes. */
export interface ZipSource {
  readonly path: string;
  readonly mtimeMs: number;
  readonly body: AsyncIterable<Uint8Array>;
}

const DOS_EPOCH_MS = Date.UTC(1980, 0, 1);

/**
 * A zip archive as a stream of chunks, built entry by entry (fflate, deflate). Memory stays at one
 * chunk of one file; the consumer's pace is the producer's (a generator). A source that throws
 * ends the archive with that error, so a truncated zip is never delivered as complete.
 */
export async function* zipChunks(sources: AsyncIterable<ZipSource>): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: Error | undefined;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else out.push(chunk);
  });
  const drain = function* (): Generator<Uint8Array> {
    if (failure) throw failure;
    while (out.length > 0) yield out.shift() as Uint8Array;
  };
  for await (const source of sources) {
    const file = new ZipDeflate(source.path, { level: 6 });
    file.mtime = Math.max(source.mtimeMs, DOS_EPOCH_MS);
    zip.add(file);
    let held: Uint8Array | undefined;
    for await (const chunk of source.body) {
      if (held) file.push(held, false);
      held = chunk;
      yield* drain();
    }
    file.push(held ?? new Uint8Array(0), true);
    yield* drain();
  }
  zip.end();
  yield* drain();
}
