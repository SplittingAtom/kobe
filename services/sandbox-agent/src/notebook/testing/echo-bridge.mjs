// A real child process speaking the kernel bridge protocol (launcher tests): echoes code as
// stdout, reports its environment on `env`, and lingers after its input ends unless told to stop.
import { createInterface } from "node:readline";

process.stdout.write(`${JSON.stringify({ ev: "ready" })}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.op !== "execute") return;
  const text = m.code === "env" ? JSON.stringify(process.env) : m.code;
  process.stdout.write(
    `${JSON.stringify({ ev: "output", id: m.id, output: { output_type: "stream", name: "stdout", text } })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ ev: "done", id: m.id, status: "ok", execution_count: 1 })}\n`,
  );
});
// Ignore the end of input: the launcher's group kill must end it.
setInterval(() => undefined, 1000);
