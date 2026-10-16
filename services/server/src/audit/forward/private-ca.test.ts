import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * KOBE-182: a syslog collector whose certificate comes from a private CA. The chart value
 * `server.extraCaBundle` mounts the CA and sets NODE_EXTRA_CA_CERTS; Node reads that variable only
 * at process start, so the sink runs in a child process, once without and once with it.
 */

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A private CA and a localhost certificate it signed. */
function makePki(dir: string): { ca: string; key: Buffer; cert: Buffer } {
  const p = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    p("ca.key"),
    "-out",
    p("ca.pem"),
    "-subj",
    "/CN=Kobe Test Private CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    p("leaf.key"),
    "-out",
    p("leaf.csr"),
    "-subj",
    "/CN=localhost",
  );
  writeFileSync(
    p("leaf.ext"),
    "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n" +
      "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    p("leaf.csr"),
    "-CA",
    p("ca.pem"),
    "-CAkey",
    p("ca.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    p("leaf.pem"),
    "-extfile",
    p("leaf.ext"),
  );
  return { ca: p("ca.pem"), key: readFileSync(p("leaf.key")), cert: readFileSync(p("leaf.pem")) };
}

/**
 * The child: the real syslog sink from source (Node strips the types; a resolve hook maps the
 * `.js` specifiers to the `.ts` files), one event, exit code = outcome.
 */
function childScript(dir: string): string {
  const file = join(dir, "send.mjs");
  const syslog = pathToFileURL(join(here, "syslog.ts")).href;
  const fixtures = pathToFileURL(join(here, "..", "fixtures.ts")).href;
  writeFileSync(
    file,
    `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    return next(specifier, context);
  },
});
const { syslogSink } = await import(${JSON.stringify(syslog)});
const { entry } = await import(${JSON.stringify(fixtures)});
const port = Number(process.argv[2]);
try {
  await syslogSink({ host: "localhost", port, tls: true }, { timeoutMs: 5000 }).send([entry({ seq: 42 })]);
  console.log("delivered");
} catch (err) {
  console.error(err.code ?? err.message);
  process.exit(1);
}
`,
  );
  return file;
}

const enabled = hasOpenssl();
let dir = "";
let pki: ReturnType<typeof makePki>;
let script = "";
let server: tls.Server;
let port = 0;
const received: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  dir = mkdtempSync(join(tmpdir(), "kobe-private-ca-"));
  pki = makePki(dir);
  script = childScript(dir);
  server = tls.createServer({ key: pki.key, cert: pki.cert }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => undefined);
    socket.on("end", () => received.push(Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function sendFromChild(extraEnv: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!("NODE_EXTRA_CA_CERTS" in extraEnv)) delete env.NODE_EXTRA_CA_CERTS;
  return run(process.execPath, [script, String(port)], { env, timeout: 20_000 });
}

describe.skipIf(!enabled)("syslog over TLS to a private CA (KOBE-182)", () => {
  it("refuses the collector without the CA bundle", async () => {
    const failure = await sendFromChild({}).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toMatch(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
    );
    expect(received).toHaveLength(0);
  });

  it("delivers once NODE_EXTRA_CA_CERTS names the CA bundle", async () => {
    const { stdout } = await sendFromChild({ NODE_EXTRA_CA_CERTS: pki.ca });
    expect(stdout.trim()).toBe("delivered");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/\[kobe@32473 seq="42"/);
  });
});
