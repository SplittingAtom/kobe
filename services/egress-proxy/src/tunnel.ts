import type { Socket } from "node:net";

export interface TunnelOptions {
  readonly client: Socket;
  readonly upstream: Socket;
  /** Bytes already read from the client (the ClientHello), sent upstream first. */
  readonly initial: Buffer;
  /** Charges forwarded bytes; returns how long to pause reading (bandwidth limit). */
  readonly throttle: (bytes: number) => number;
  readonly idleTimeoutMs: number;
}

export interface TunnelResult {
  readonly bytesUp: number;
  readonly bytesDown: number;
}

/**
 * Relays bytes both ways without looking at them (no TLS interception), with backpressure, a
 * bandwidth throttle and an idle timeout. Resolves when both sockets are closed; either side
 * closing or failing tears down the other.
 */
export function runTunnel(options: TunnelOptions): Promise<TunnelResult> {
  const { client, upstream } = options;
  let bytesUp = options.initial.length;
  let bytesDown = 0;
  return new Promise((resolve) => {
    let closed = 0;
    const timers = new Set<NodeJS.Timeout>();
    const teardown = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      client.destroy();
      upstream.destroy();
    };
    const onClose = () => {
      teardown();
      closed += 1;
      if (closed === 2) resolve({ bytesUp, bytesDown });
    };
    client.once("close", onClose);
    upstream.once("close", onClose);
    client.on("error", teardown);
    upstream.on("error", teardown);
    for (const socket of [client, upstream]) {
      socket.setTimeout(options.idleTimeoutMs, teardown);
    }

    const pump = (src: Socket, dst: Socket, count: (n: number) => void) => {
      src.on("data", (chunk: Buffer) => {
        count(chunk.length);
        const flushed = dst.write(chunk);
        const delay = options.throttle(chunk.length);
        if (flushed && delay <= 0) return;
        src.pause();
        let waiting = (flushed ? 0 : 1) + (delay > 0 ? 1 : 0);
        const done = () => {
          waiting -= 1;
          if (waiting === 0 && !src.destroyed) src.resume();
        };
        if (!flushed) dst.once("drain", done);
        if (delay > 0) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            done();
          }, delay);
          timers.add(timer);
        }
      });
      src.on("end", () => dst.end());
    };

    if (options.initial.length > 0) {
      options.throttle(options.initial.length);
      upstream.write(options.initial);
    }
    pump(client, upstream, (n) => (bytesUp += n));
    pump(upstream, client, (n) => (bytesDown += n));
    client.resume();
  });
}
