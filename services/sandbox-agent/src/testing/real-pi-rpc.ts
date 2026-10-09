import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PI_LOCKDOWN_ARGS } from "../pi/pi-launch.js";

/**
 * A bare driver for the REAL pinned Pi 1.0.0 in RPC mode, started the way the agent starts it
 * (lockdown flags, a private agent dir, kobe-models then kobe-policy, the policy channel on fd 3,
 * the model file named by KOBE_MODEL_FILE) but without the agent in between: no tripwire, no
 * model-file bookkeeping. Tests that ask what Pi itself does with a planted `agent/` directory
 * need exactly that (KOBE-165). Answers Pi's `kobe.run_token` dialog like the agent does.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** An HTTP listener that records every connection and request and answers nothing useful. */
export interface Listener {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly connections: () => number;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function shut(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startListener(
  respond?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Listener> {
  const requests: RecordedRequest[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    if (respond !== undefined) respond(req, res);
    else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  server.on("connection", () => (connections += 1));
  const url = await listen(server);
  return { url, requests, connections: () => connections, close: () => shut(server) };
}

/**
 * The legitimate gateway as Pi sees it: records every request's headers, then forwards it to the
 * real (local) gateway minus the run token header, which the local gateway has no record of.
 */
export async function startTap(upstream: string): Promise<Listener> {
  return startListener((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = { ...req.headers, host: new URL(upstream).host };
      Reflect.deleteProperty(headers, "x-kobe-run-token");
      const out = http.request(
        upstream + (req.url ?? "/"),
        { method: req.method, headers },
        (back) => {
          res.writeHead(back.statusCode ?? 502, back.headers);
          back.pipe(res);
        },
      );
      out.on("error", () => res.destroy());
      out.end(Buffer.concat(chunks));
    });
  });
}

export interface PiRpcOptions {
  readonly piBin: string;
  readonly modelsExtension: string;
  readonly policyExtension: string;
  readonly gatewayUrl: string;
  /** Runs on the fresh agent dir before Pi starts (KOBE-169: the agent's guarded files). */
  readonly prepareAgentDir?: (agentDir: string) => Promise<void>;
}

export interface ModelChoice {
  readonly gateway_model: string;
  readonly api: "openai-completions" | "anthropic-messages" | "google-generative-ai";
}

type Message = Record<string, unknown>;

export class PiRpc {
  readonly dir: string;
  readonly agentDir: string;
  readonly workspace: string;
  readonly events: Message[] = [];
  #child: ChildProcess;
  #modelFile: string;
  #gatewayUrl: string;
  #runToken = "";
  #waiters: ((m: Message) => boolean)[] = [];
  #seq = 0;

  private constructor(dir: string, child: ChildProcess, options: PiRpcOptions) {
    this.dir = dir;
    this.agentDir = path.join(dir, "agent");
    this.workspace = path.join(dir, "workspace");
    this.#modelFile = path.join(dir, "model.json");
    this.#child = child;
    this.#gatewayUrl = options.gatewayUrl;
  }

  static async start(options: PiRpcOptions, sessionToken: string): Promise<PiRpc> {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-pi-rpc-"));
    await mkdir(path.join(dir, "agent"), { mode: 0o700 });
    await mkdir(path.join(dir, "workspace"));
    await options.prepareAgentDir?.(path.join(dir, "agent"));
    const modelFile = path.join(dir, "model.json");
    await writeFile(
      modelFile,
      JSON.stringify({
        v: 1,
        gateway_url: options.gatewayUrl,
        model: null,
        token: sessionToken,
        run_id: null,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      options.piBin,
      [
        "--mode",
        "rpc",
        "--no-session",
        ...PI_LOCKDOWN_ARGS,
        "--extension",
        options.modelsExtension,
        "--extension",
        options.policyExtension,
      ],
      {
        cwd: path.join(dir, "workspace"),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(dir, "home"),
          PI_CODING_AGENT_DIR: path.join(dir, "agent"),
          KOBE_MODEL_FILE: modelFile,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
          KOBE_POLICY_FD: "3",
        },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      },
    );
    const pi = new PiRpc(dir, child, options);
    pi.#wire();
    await pi.#waitReady();
    return pi;
  }

  #lines(stream: NodeJS.ReadableStream, onLine: (m: Message) => void): void {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() !== "") onLine(JSON.parse(line) as Message);
      }
    });
  }

  #write(stream: NodeJS.WritableStream | null | undefined, message: Message): void {
    stream?.write(`${JSON.stringify(message)}\n`);
  }

  #wire(): void {
    const channel = this.#child.stdio[3] as unknown as Duplex;
    this.#lines(channel, (m) => {
      this.#notify(m);
      if (m.type === "policy.check") {
        this.#write(channel, {
          type: "policy.result",
          request_id: m.request_id,
          tool_call_id: m.tool_call_id,
          decision: "allow",
          reasons: [],
        });
      }
    });
    this.#write(channel, { type: "channel.hello", nonce: "real-pi-rpc" });
    this.#lines(this.#child.stdout as NodeJS.ReadableStream, (m) => {
      this.events.push(m);
      if (
        m.type === "extension_ui_request" &&
        m.method === "input" &&
        m.title === "kobe.run_token"
      ) {
        this.#write(this.#child.stdin, {
          type: "extension_ui_response",
          id: m.id,
          value: this.#runToken,
        });
      }
      this.#notify(m);
    });
  }

  #notify(m: Message): void {
    this.#waiters = this.#waiters.filter((w) => !w(m));
  }

  #wait(match: (m: Message) => boolean, ms: number, what: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      this.#waiters.push((m) => {
        if (!match(m)) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      });
    });
  }

  #waitReady(): Promise<void> {
    return this.#wait((m) => m.type === "channel.ready", 30_000, "kobe-policy ready").then(
      () => undefined,
    );
  }

  /** Point the model file at a run (as the agent does before a prompt) and hand out its token. */
  async attachRun(runId: string, model: ModelChoice, sessionToken: string, runToken: string) {
    this.#runToken = runToken;
    await writeFile(
      this.#modelFile,
      JSON.stringify({
        v: 1,
        gateway_url: this.#gatewayUrl,
        model,
        token: sessionToken,
        run_id: runId,
      }),
      { mode: 0o600 },
    );
  }

  /** A prompt, resolved when the agent settles. */
  async prompt(message: string, ms = 60_000): Promise<void> {
    const settled = this.#wait((m) => m.type === "agent_settled", ms, `agent_settled (${message})`);
    this.#write(this.#child.stdin, { type: "prompt", id: `p${(this.#seq += 1)}`, message });
    await settled;
  }

  /** Any other RPC command; resolves with its response. */
  async command(command: Message, ms = 30_000): Promise<Message> {
    const id = `c${(this.#seq += 1)}`;
    const response = this.#wait(
      (m) => m.type === "response" && m.id === id,
      ms,
      String(command.type),
    );
    this.#write(this.#child.stdin, { ...command, id });
    return response;
  }

  /** The assistant text of the last settled turn. */
  lastText(): string {
    return this.events
      .flatMap((m) => {
        const e = m.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        return m.type === "message_update" && e?.type === "text_delta" ? [e.delta ?? ""] : [];
      })
      .join("");
  }

  async close(): Promise<void> {
    this.#child.kill("SIGKILL");
    await rm(this.dir, { recursive: true, force: true });
  }
}
