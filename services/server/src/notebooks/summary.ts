import { NOTEBOOK_TOOL_TEXT_MAX_BYTES, type NotebookOutput } from "@kobe/protocol";

/**
 * What the model gets back from `run_python` (docs/specs/notebooks.md NB13): stream text, results
 * as `text/plain`, errors with their traceback (ANSI codes removed), and a one-line note for what
 * only the user sees (images, HTML). At most {@link NOTEBOOK_TOOL_TEXT_MAX_BYTES}: the head and the
 * tail are kept (errors come last), the middle is cut with a note.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

function outputText(output: NotebookOutput): string {
  switch (output.output_type) {
    case "stream":
      return output.text;
    case "error":
      return `${[...output.traceback, `${output.ename}: ${output.evalue}`].join("\n").replace(ANSI, "")}\n`;
    default: {
      const plain = output.data["text/plain"];
      const rich = Object.keys(output.data).filter((m) => m !== "text/plain");
      const note = rich.length > 0 ? `[${rich.join(", ")} output shown to the user]\n` : "";
      const text = typeof plain === "string" ? `${plain}\n` : "";
      return rich.some((m) => m.startsWith("image/")) ? `${note}${text}` : `${text}${note}`;
    }
  }
}

export function toolText(
  outputs: readonly NotebookOutput[],
  max = NOTEBOOK_TOOL_TEXT_MAX_BYTES,
): string {
  const text = outputs.map(outputText).join("");
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const note = `\n[... ${bytes.length - max} bytes cut ...]\n`;
  const room = max - Buffer.byteLength(note);
  const head = bytes
    .subarray(0, Math.floor(room * 0.3))
    .toString("utf8")
    .replace(/�$/u, "");
  const tail = bytes
    .subarray(bytes.length - (room - Buffer.byteLength(head)))
    .toString("utf8")
    .replace(/^�/u, "");
  return `${head}${note}${tail}`;
}
