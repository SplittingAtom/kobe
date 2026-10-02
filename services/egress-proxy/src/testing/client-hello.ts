import { createServer, type AddressInfo } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { parseClientHello } from "../client-hello.js";

/** The ClientHello a real Node TLS client sends for `servername` (captured, never answered). */
export function captureClientHello(servername: string | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on("data", (c: Buffer) => {
        chunks.push(c);
        const all = Buffer.concat(chunks);
        if (parseClientHello(all).status !== "incomplete") {
          sock.destroy();
          server.close();
          resolve(all);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const client = tlsConnect({
        port,
        host: "127.0.0.1",
        ...(servername === undefined ? {} : { servername }),
        rejectUnauthorized: false,
      });
      client.on("error", () => undefined);
    });
  });
}
