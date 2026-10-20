/**
 * An export's body as the route sends it (KOBE-18, KOBE-450): `release` runs once when the stream
 * ends, fails or the client goes away (the user's export slot); a failure is reported through
 * `failed`. With `tail`, a failure ends the download with it (a Markdown file then says it is
 * incomplete) instead of erroring the stream (a zip can't be closed cleanly part way).
 */
export function trackedDownload(
  body: ReadableStream<Uint8Array>,
  hooks: {
    readonly release: () => void;
    readonly failed: (err: unknown) => void;
    readonly tail?: Uint8Array;
  },
): ReadableStream<Uint8Array> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hooks.release();
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        release();
        hooks.failed(err);
        if (hooks.tail) {
          controller.enqueue(hooks.tail);
          controller.close();
        } else controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}
