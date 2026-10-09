import { serveExecutor } from "./server.js";

/**
 * The tool executor program (KOBE-167): `node dist/exec/executor/main.js`, started by the sandbox
 * agent through `kobe-runas` as the partner uid of a Pi identity. Its stdin/stdout are the channel
 * the agent's relay speaks (exec/relay.ts); stderr is a diagnostic tail the agent logs. Its
 * environment is the allow-list the agent built; every command it runs inherits exactly that.
 */
const executor = serveExecutor({
  input: process.stdin,
  output: process.stdout,
  commandEnv: process.env,
  log: (message) => process.stderr.write(`kobe-executor: ${message}\n`),
});
void executor.done.then(() => {
  // Everything started is killed; leave once the replies are flushed.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 50).unref();
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`kobe-executor: fatal: ${error.stack ?? error.message}\n`);
  process.exit(70);
});
