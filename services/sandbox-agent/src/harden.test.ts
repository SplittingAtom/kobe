import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hardenProcess, inspectorRequested } from "./harden.js";

describe("process hardening", () => {
  it("refuses an inspector requested through flags or NODE_OPTIONS", () => {
    expect(inspectorRequested({ execArgv: ["--inspect=0"], env: {} })).toBe(true);
    expect(inspectorRequested({ execArgv: [], env: { NODE_OPTIONS: "--inspect-brk" } })).toBe(true);
    expect(inspectorRequested({ execArgv: ["--disable-sigusr1"], env: {} })).toBe(false);
    const on = () => undefined;
    expect(() => hardenProcess({ execArgv: [], env: { NODE_OPTIONS: "--inspect" }, on })).toThrow(
      /inspector/,
    );
  });

  it("installs a SIGUSR1 listener", () => {
    const signals: string[] = [];
    hardenProcess({ execArgv: [], env: {}, on: (signal) => signals.push(signal) });
    expect(signals).toEqual(["SIGUSR1"]);
  });

  async function urlAfterSigusr1(harden: boolean): Promise<string | undefined> {
    const module = fileURLToPath(new URL("./harden.ts", import.meta.url));
    const script = `
      const { hardenProcess } = await import(${JSON.stringify(module)});
      if (${String(harden)}) hardenProcess(process);
      process.kill(process.pid, "SIGUSR1");
      setTimeout(async () => {
        const inspector = await import("node:inspector");
        console.log(String(inspector.url()));
        process.exit(0);
      }, 500);`;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise((resolve) => child.on("exit", resolve));
    return out.trim().split("\n").at(-1);
  }

  it.skipIf(process.platform === "win32")(
    "SIGUSR1 (kill -USR1 by sandbox code) opens no inspector once hardened",
    async () => {
      expect(await urlAfterSigusr1(false)).toMatch(/^ws:\/\/127\.0\.0\.1:/); // control
      expect(await urlAfterSigusr1(true)).toBe("undefined");
    },
  );
});
