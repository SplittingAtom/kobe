import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { entry } from "../fixtures.js";
import { loadAuditForwardingConfig } from "./config.js";
import { exportLogsRequest, otlpSink } from "./otlp.js";
import { formatSyslogMessage, syslogSink } from "./syslog.js";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

/** Splits an octet-counted stream (RFC 6587) into messages. */
function unframe(data: Buffer): string[] {
  const messages: string[] = [];
  let rest = data;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    const length = Number(rest.subarray(0, space).toString("ascii"));
    messages.push(rest.subarray(space + 1, space + 1 + length).toString("utf8"));
    rest = rest.subarray(space + 1 + length);
  }
  return messages;
}

function collect(server: net.Server, received: Buffer[][], event = "connection"): void {
  server.on(event, (socket: net.Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => undefined);
    socket.on("end", () => received.push(chunks));
  });
}

async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("syslog (RFC 5424)", () => {
  it("formats header, structured data and a JSON body", () => {
    const message = formatSyslogMessage(
      entry({ seq: 7, teamId: "33333333-3333-4333-8333-333333333333" }),
      { hostname: "kobe-0", procId: 42 },
    );
    expect(message).toMatch(
      /^<110>1 2026-10-01T12:00:00\.123Z kobe-0 kobe-audit 42 identity\.team\.created \[kobe@32473 seq="7" id="[^"]+" team="[^"]+" actorKind="user" actor="[^"]+" hash="b{64}"\] \{/,
    );
    const body = JSON.parse(message.slice(message.indexOf("] {") + 2)) as { action: string };
    expect(body.action).toBe("identity.team.created");
  });

  it("limits MSGID to 32 characters and uses - for empty header fields", () => {
    const message = formatSyslogMessage(entry({ action: "x".repeat(60) }), { hostname: "" });
    expect(message.split(" ")[2]).toBe("-");
    expect(message.split(" ")[5]).toHaveLength(32);
  });

  it("delivers octet-counted frames to a TCP collector", async () => {
    const received: Buffer[][] = [];
    const server = net.createServer();
    collect(server, received);
    const port = await listen(server);
    await syslogSink({ host: "127.0.0.1", port, tls: false }).send([
      entry({ seq: 1 }),
      entry({ seq: 2 }),
    ]);
    await settle();
    const messages = unframe(Buffer.concat(received[0] ?? []));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('seq="2"');
  });

  it("rejects when nothing listens", async () => {
    const server = net.createServer();
    const port = await listen(server);
    server.close();
    await settle();
    await expect(
      syslogSink({ host: "127.0.0.1", port, tls: false }).send([entry()]),
    ).rejects.toThrow();
  });

  it("delivers over TLS, verifying the collector's certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-syslog-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(dir, "k.pem"),
          "-out",
          join(dir, "c.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
    } catch {
      return; // no openssl on this machine: the plain TCP test still covers framing
    }
    const cert = readFileSync(join(dir, "c.pem"));
    const received: Buffer[][] = [];
    const server = tls.createServer({ key: readFileSync(join(dir, "k.pem")), cert });
    collect(server as unknown as net.Server, received, "secureConnection");
    const port = await listen(server as unknown as net.Server);
    await syslogSink({ host: "localhost", port, tls: true }, { tlsOptions: { ca: cert } }).send([
      entry(),
    ]);
    await settle();
    expect(unframe(Buffer.concat(received[0] ?? []))).toHaveLength(1);
    // Without the CA the certificate is refused.
    await expect(
      syslogSink({ host: "localhost", port, tls: true }).send([entry()]),
    ).rejects.toThrow();
  });
});

describe("OTLP logs", () => {
  it("maps events to log records", () => {
    const body = exportLogsRequest([
      entry({ seq: 5, teamId: "33333333-3333-4333-8333-333333333333" }),
    ]);
    const record = body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(record?.timeUnixNano).toBe("1790856000123000000");
    expect(record?.body).toEqual({ stringValue: "identity.team.created" });
    expect(record?.attributes).toContainEqual({ key: "kobe.audit.seq", value: { intValue: "5" } });
    expect(record?.attributes.map((a) => a.key)).toContain("kobe.audit.team_id");
  });

  it("posts JSON with the configured headers and fails on non-2xx", async () => {
    const seen: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = [];
    let status = 200;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ headers: req.headers, body, url: req.url ?? "" });
        res.statusCode = status;
        res.end("{}");
      });
    });
    const port = await listen(server);
    const sink = otlpSink({
      url: `http://127.0.0.1:${port}/v1/logs`,
      headers: { authorization: "Bearer t" },
    });
    await sink.send([entry({ seq: 1 }), entry({ seq: 2 })]);
    expect(seen[0]?.url).toBe("/v1/logs");
    expect(seen[0]?.headers.authorization).toBe("Bearer t");
    expect(JSON.parse(seen[0]?.body ?? "").resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
    status = 503;
    await expect(sink.send([entry()])).rejects.toThrow("HTTP 503");
  });
});

describe("forwarding config", () => {
  it("is empty by default", () => {
    expect(loadAuditForwardingConfig({})).toEqual({});
    expect(
      loadAuditForwardingConfig({ KOBE_AUDIT_SYSLOG_URL: "", KOBE_AUDIT_OTLP_URL: "" }),
    ).toEqual({});
  });

  it("reads syslog and OTLP settings", () => {
    expect(
      loadAuditForwardingConfig({
        KOBE_AUDIT_SYSLOG_URL: "tls://siem.example.test:6514",
        KOBE_AUDIT_OTLP_URL: "https://otel.example.test:4318/v1/logs",
        KOBE_AUDIT_OTLP_HEADERS: "authorization=Bearer%20x, x-team=a",
      }),
    ).toEqual({
      syslog: { host: "siem.example.test", port: 6514, tls: true },
      otlp: {
        url: "https://otel.example.test:4318/v1/logs",
        headers: { authorization: "Bearer x", "x-team": "a" },
      },
    });
  });

  it("rejects bad values without echoing them", () => {
    expect(() => loadAuditForwardingConfig({ KOBE_AUDIT_SYSLOG_URL: "udp://h:514" })).toThrow(
      /tcp:\/\/ or tls:\/\//,
    );
    expect(() => loadAuditForwardingConfig({ KOBE_AUDIT_SYSLOG_URL: "tcp://h" })).toThrow(/port/);
    expect(() => loadAuditForwardingConfig({ KOBE_AUDIT_OTLP_URL: "ftp://x" })).toThrow(
      /KOBE_AUDIT_OTLP_URL/,
    );
  });
});
