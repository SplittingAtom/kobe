import { createServer, type Server, type Socket } from "node:net";

/** The EICAR antivirus test string: harmless, and every scanner flags it by convention. */
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export interface FakeClamd {
  readonly port: number;
  /** Number of INSTREAM scans served. */
  scans(): number;
  close(): Promise<void>;
}

/**
 * A clamd stand-in for tests: speaks the INSTREAM protocol over TCP (`zINSTREAM\0`, then
 * length-prefixed chunks ending with a zero length) and answers `FOUND` when the stream contains
 * the EICAR string, `OK` otherwise. `mode` forces other replies.
 */
export async function startFakeClamd(
  mode: "scan" | "error" | "hang" | "garbage" = "scan",
): Promise<FakeClamd> {
  let served = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (mode === "hang") return;
    let buf = Buffer.alloc(0);
    let started = false;
    const chunks: Buffer[] = [];
    socket.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      if (!started) {
        const cmd = "zINSTREAM\0";
        if (buf.length < cmd.length) return;
        if (buf.subarray(0, cmd.length).toString() !== cmd) {
          socket.end("UNKNOWN COMMAND\0");
          return;
        }
        started = true;
        buf = buf.subarray(cmd.length);
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          served += 1;
          const found = Buffer.concat(chunks).includes(EICAR);
          const reply =
            mode === "error"
              ? "INSTREAM size limit exceeded. ERROR"
              : mode === "garbage"
                ? "what?"
                : found
                  ? "stream: Eicar-Test-Signature FOUND"
                  : "stream: OK";
          socket.end(`${reply}\0`);
          return;
        }
        if (buf.length < 4 + len) return;
        chunks.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    scans: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
