import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBifrostAdmin } from "./bifrost-admin.js";
import { buildDesiredState, virtualKeyName, type ProviderInput } from "./desired.js";
import { reconcile } from "./reconcile.js";

/**
 * The real Bifrost (KOBE-40, D30 ac-3): the HTTP admin client and a reconcile pass against an
 * actual Bifrost binary, then inference with a member's virtual key through each provider kind
 * (OpenAI, Anthropic native, Gemini, Ollama, OpenAI-compatible) to a fake upstream. Opt-in:
 * KOBE_TEST_BIFROST_BIN=<path to bifrost-http> (CI has no binary; e2e runs the real image).
 */
const BIN = process.env.KOBE_TEST_BIFROST_BIN;
const PASSWORD = "integration-admin-password-0001";
const logger = pino({ level: "silent" });

/** Minimal OpenAI / Anthropic / Gemini upstream; records which credential reached it. */
function fakeUpstream(seen: string[]): Server {
  return createServer((req, res) => {
    const auth =
      req.headers.authorization ?? req.headers["x-api-key"] ?? req.headers["x-goog-api-key"];
    seen.push(`${req.method} ${req.url} ${String(auth ?? "-")}`);
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "";
      let body: unknown = { object: "list", data: [] };
      if (path.includes("/chat/completions")) {
        body = {
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "pong-openai" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      } else if (path.endsWith("/v1/messages")) {
        body = {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "pong-anthropic" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      } else if (path.includes(":generateContent")) {
        body = {
          candidates: [
            { content: { role: "model", parts: [{ text: "pong-gemini" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
}

describe.skipIf(!BIN)("against a real Bifrost", () => {
  let dir = "";
  let bifrost: ChildProcess | undefined;
  let upstream: Server;
  const seen: string[] = [];
  let base = "";
  let up = "";

  beforeAll(async () => {
    upstream = fakeUpstream(seen);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "kobe-bifrost-"));
    const port = 18000 + Math.floor(Math.random() * 1000);
    base = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        encryption_key: "env.BIFROST_ENCRYPTION_KEY",
        client: {
          enforce_auth_on_inference: true,
          enable_logging: false,
          disable_content_logging: true,
          allow_direct_keys: false,
        },
        governance: {
          auth_config: {
            admin_username: "env.BIFROST_ADMIN_USERNAME",
            admin_password: "env.BIFROST_ADMIN_PASSWORD",
            is_enabled: true,
          },
        },
        config_store: { enabled: true, type: "sqlite", config: { path: join(dir, "config.db") } },
        logs_store: { enabled: false },
      }),
    );
    bifrost = spawn(BIN ?? "", ["-app-dir", dir, "-port", String(port), "-host", "127.0.0.1"], {
      env: {
        ...process.env,
        BIFROST_ENCRYPTION_KEY: "integration-encryption-key-0001",
        BIFROST_ADMIN_USERNAME: "kobe",
        BIFROST_ADMIN_PASSWORD: PASSWORD,
      },
      stdio: "ignore",
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ok = await fetch(`${base}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("bifrost did not start");
  }, 90_000);

  afterAll(async () => {
    bifrost?.kill("SIGTERM");
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("reconciles, then each provider kind answers through a member's virtual key", async () => {
    const admin = createHttpBifrostAdmin({ baseUrl: base, username: "kobe", password: PASSWORD });
    const teamId = randomUUID();
    const userId = randomUUID();
    const providers: ProviderInput[] = [
      { id: "openai", kind: "openai", baseUrl: up, allowPrivateNetwork: true, apiKey: "up-openai" },
      {
        id: "anthropic",
        kind: "anthropic",
        baseUrl: up,
        allowPrivateNetwork: true,
        apiKey: "up-anthropic",
      },
      {
        id: "gemini",
        kind: "gemini",
        baseUrl: `${up}/v1beta`,
        allowPrivateNetwork: true,
        apiKey: "up-gemini",
      },
      { id: "ollama", kind: "ollama", baseUrl: up, allowPrivateNetwork: true, apiKey: undefined },
      {
        id: "vllm",
        kind: "openai_compatible",
        baseUrl: up,
        allowPrivateNetwork: true,
        apiKey: undefined,
      },
    ];
    const catalog = [
      { alias: "fast", providerId: "openai", model: "gpt-x" },
      { alias: "smart", providerId: "anthropic", model: "claude-x" },
      { alias: "gem", providerId: "gemini", model: "gemini-x" },
      { alias: "local", providerId: "ollama", model: "llama-x" },
      { alias: "qwen", providerId: "vllm", model: "qwen-x" },
    ];
    const desired = buildDesiredState(
      {
        providers,
        catalog,
        teams: [{ teamId, members: [userId], aliases: catalog.map((c) => c.alias) }],
      },
      "f".repeat(40),
    );
    const first = await reconcile(desired, admin, logger);
    expect(first.errors).toEqual([]);
    const second = await reconcile(desired, admin, logger);
    expect(second.changes).toBe(0);
    const vk = first.virtualKeys.get(virtualKeyName(teamId, userId))?.value ?? "";
    expect(vk).toMatch(/^sk-bf-/);

    const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const chat = (model: string, h: Record<string, string>) =>
      call("/v1/chat/completions", { model, messages: [{ role: "user", content: "ping" }] }, h);

    const vkHeader = { "x-bf-vk": vk };
    expect((await chat("openai/gpt-x", vkHeader)).text).toContain("pong-openai");
    expect((await chat("ollama/llama-x", vkHeader)).text).toContain("pong-openai");
    expect((await chat("kobe-vllm/qwen-x", vkHeader)).text).toContain("pong-openai");
    const anthropic = await call(
      "/anthropic/v1/messages",
      { model: "anthropic/claude-x", max_tokens: 8, messages: [{ role: "user", content: "ping" }] },
      { ...vkHeader, "anthropic-version": "2023-06-01" },
    );
    expect(anthropic.text).toContain("pong-anthropic");
    const gemini = await call(
      "/genai/v1beta/models/gemini/gemini-x:generateContent",
      { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
      vkHeader,
    );
    expect(gemini.text).toContain("pong-gemini");
    // Provider keys reached the upstream; the virtual key never did.
    expect(seen.some((s) => s.includes("up-anthropic"))).toBe(true);
    expect(seen.some((s) => s.includes("up-gemini"))).toBe(true);
    expect(seen.some((s) => s.includes("sk-bf-"))).toBe(false);

    // Refusals: no key, another team's model, a removed member.
    expect((await chat("openai/gpt-x", {})).status).toBe(401);
    expect((await chat("openai/not-enabled", vkHeader)).status).toBe(403);
    const removed = buildDesiredState(
      { providers, catalog, teams: [{ teamId, members: [], aliases: [] }] },
      "f".repeat(40),
    );
    expect((await reconcile(removed, admin, logger)).errors).toEqual([]);
    expect((await chat("openai/gpt-x", vkHeader)).status).toBe(401);
  }, 60_000);
});
