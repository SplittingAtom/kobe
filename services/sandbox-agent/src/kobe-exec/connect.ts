import { fstatSync } from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { ExecClient, unavailableTransport, type ExecTransport } from "./client.js";
import { EXEC_FD_ENV } from "./protocol.js";

/** The channel from the inherited fd; the variable is read once and removed from `process.env`. */
export function connect(
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
  open: (fd: number) => Duplex = openSocketFd,
): ExecTransport {
  const raw = env[EXEC_FD_ENV];
  Reflect.deleteProperty(env, EXEC_FD_ENV);
  if (raw === undefined || !/^[0-9]{1,4}$/.test(raw) || Number(raw) < 5) {
    warn(`kobe-exec: missing or invalid ${EXEC_FD_ENV}; every tool will fail`);
    return unavailableTransport("the exec channel was not provided");
  }
  try {
    return new ExecClient(open(Number(raw)));
  } catch (error) {
    warn(`kobe-exec: cannot open the channel: ${(error as Error).message}; every tool will fail`);
    return unavailableTransport("the exec channel cannot be opened");
  }
}

/** fd 5 must be the socket the agent passed. */
function openSocketFd(fd: number): Duplex {
  if (!fstatSync(fd).isSocket()) throw new Error(`fd ${fd} is not a socket`);
  const socket = new net.Socket({ fd, readable: true, writable: true });
  // Never keep Pi alive on its own account: Pi's lifetime is its stdin's.
  socket.unref();
  return socket;
}
