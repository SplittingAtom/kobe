import inspector from "node:inspector";

/**
 * The agent holds the wire token and decides what reaches the server, and model-run code in the
 * sandbox runs as the same uid. Node opens an inspector (arbitrary code execution) on SIGUSR1, or
 * when started with `--inspect*` (also via NODE_OPTIONS). The image runs `node --disable-sigusr1`;
 * this is the in-process belt to that brace: a SIGUSR1 listener replaces Node's default
 * inspector-activating handler, and the agent refuses to run with an inspector configured.
 */
export interface HardenableProcess {
  readonly execArgv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  on(signal: "SIGUSR1", listener: () => void): unknown;
}

const INSPECT_FLAG = /--inspect|--debug/;

export function inspectorRequested(proc: Pick<HardenableProcess, "execArgv" | "env">): boolean {
  return (
    proc.execArgv.some((arg) => INSPECT_FLAG.test(arg)) ||
    INSPECT_FLAG.test(proc.env.NODE_OPTIONS ?? "") ||
    inspector.url() !== undefined
  );
}

export function hardenProcess(proc: HardenableProcess): void {
  proc.on("SIGUSR1", () => undefined);
  if (inspectorRequested(proc)) {
    throw new Error("refusing to run with a Node inspector enabled (--inspect / NODE_OPTIONS)");
  }
}
