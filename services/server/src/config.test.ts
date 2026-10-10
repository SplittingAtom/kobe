import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const REQUIRED = {
  KOBE_DATABASE_URL: "postgres://kobe_app:pw@db:5432/kobe",
  KOBE_PUBLIC_URL: "https://kobe.example.com",
  KOBE_AUTH_SECRET: "x".repeat(32),
  KOBE_SETUP_TOKEN: "t".repeat(24),
  KOBE_SMTP_HOST: "smtp.example.com",
  KOBE_SMTP_FROM: "Kobe <kobe@example.com>",
};

describe("loadConfig", () => {
  it("defaults the port to 8080 and the process to the API server", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({ port: 8080, process: "server" });
  });

  it("reads PORT and KOBE_PROCESS", () => {
    expect(loadConfig({ ...REQUIRED, PORT: "9090", KOBE_PROCESS: "scheduler" })).toMatchObject({
      port: 9090,
      process: "scheduler",
    });
  });

  it("rejects an invalid port or process role with a clear error", () => {
    expect(() => loadConfig({ ...REQUIRED, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...REQUIRED, KOBE_PROCESS: "worker" })).toThrow(/KOBE_PROCESS/);
  });

  it("caps agent versions at 1000 by default, configurable within 1–100000 (KOBE-46)", () => {
    expect(loadConfig(REQUIRED).agentMaxVersions).toBe(1000);
    expect(loadConfig({ ...REQUIRED, KOBE_AGENT_MAX_VERSIONS: "50" }).agentMaxVersions).toBe(50);
    expect(() => loadConfig({ ...REQUIRED, KOBE_AGENT_MAX_VERSIONS: "0" })).toThrow(
      /KOBE_AGENT_MAX_VERSIONS/,
    );
  });

  it("reads the internal listener settings for the MCP proxy (KOBE-58)", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      internalPort: 8082,
      mcpProxyInternalKey: undefined,
    });
    expect(
      loadConfig({
        ...REQUIRED,
        KOBE_INTERNAL_PORT: "9000",
        KOBE_MCP_PROXY_INTERNAL_KEY: "k".repeat(32),
      }),
    ).toMatchObject({ internalPort: 9000, mcpProxyInternalKey: "k".repeat(32) });
    expect(() => loadConfig({ ...REQUIRED, KOBE_MCP_PROXY_INTERNAL_KEY: "short" })).toThrow(
      /KOBE_MCP_PROXY_INTERNAL_KEY/,
    );
  });

  it("reads the MCP proxy address for the pinning probe (KOBE-101)", () => {
    expect(loadConfig(REQUIRED).mcpProxyUrl).toBeUndefined();
    expect(
      loadConfig({ ...REQUIRED, KOBE_MCP_PROXY_URL: "http://kobe-mcp-proxy:80" }).mcpProxyUrl,
    ).toBe("http://kobe-mcp-proxy:80");
    expect(() => loadConfig({ ...REQUIRED, KOBE_MCP_PROXY_URL: "ftp://x" })).toThrow(
      /KOBE_MCP_PROXY_URL/,
    );
  });

  it("requires a postgres database URL", () => {
    const { KOBE_DATABASE_URL: _, ...rest } = REQUIRED;
    expect(() => loadConfig(rest)).toThrow(/KOBE_DATABASE_URL/);
    expect(() => loadConfig({ ...REQUIRED, KOBE_DATABASE_URL: "mysql://x" })).toThrow(
      /KOBE_DATABASE_URL/,
    );
  });

  it("requires an http(s) public URL without a path", () => {
    expect(loadConfig(REQUIRED).auth?.publicUrl).toBe("https://kobe.example.com");
    expect(() => loadConfig({ ...REQUIRED, KOBE_PUBLIC_URL: "kobe.example.com" })).toThrow(
      /KOBE_PUBLIC_URL/,
    );
    expect(() =>
      loadConfig({ ...REQUIRED, KOBE_PUBLIC_URL: "https://kobe.example.com/app" }),
    ).toThrow(/KOBE_PUBLIC_URL/);
  });

  it("requires an auth secret of at least 32 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_AUTH_SECRET: "short" })).toThrow(
      /KOBE_AUTH_SECRET/,
    );
  });

  it("requires a setup token of at least 24 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_SETUP_TOKEN: "short" })).toThrow(
      /KOBE_SETUP_TOKEN/,
    );
  });

  it("reads an optional approval key of at least 32 characters (KOBE-37), never for the scheduler", () => {
    expect(loadConfig(REQUIRED).auth?.approvalKey).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, KOBE_APPROVAL_KEY: "" }).auth?.approvalKey).toBeUndefined();
    const key = "a".repeat(48);
    expect(loadConfig({ ...REQUIRED, KOBE_APPROVAL_KEY: key }).auth?.approvalKey).toBe(key);
    expect(() => loadConfig({ ...REQUIRED, KOBE_APPROVAL_KEY: "short" })).toThrow(
      /KOBE_APPROVAL_KEY must be at least 32/,
    );
    expect(
      loadConfig({ ...REQUIRED, KOBE_PROCESS: "scheduler", KOBE_APPROVAL_KEY: key }).auth,
    ).toBeUndefined();
  });

  it("parses trusted proxy CIDRs", () => {
    expect(loadConfig(REQUIRED).auth?.trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...REQUIRED, KOBE_TRUSTED_PROXIES: "10.42.0.0/16, 10.43.0.0/16" }).auth
        ?.trustedProxies,
    ).toEqual(["10.42.0.0/16", "10.43.0.0/16"]);
    expect(() => loadConfig({ ...REQUIRED, KOBE_TRUSTED_PROXIES: "not-a-cidr" })).toThrow(
      /KOBE_TRUSTED_PROXIES/,
    );
  });

  it("does not give the scheduler auth secrets (least privilege)", () => {
    const scheduler = loadConfig({
      KOBE_PROCESS: "scheduler",
      KOBE_DATABASE_URL: REQUIRED.KOBE_DATABASE_URL,
    });
    expect(scheduler.auth).toBeUndefined();
    expect(loadConfig(REQUIRED).auth).toMatchObject({ setupToken: "t".repeat(24) });
  });

  it("never echoes secret values in errors", () => {
    expect(() => loadConfig({ ...REQUIRED, KOBE_AUTH_SECRET: "hunter2" })).not.toThrow(/hunter2/);
  });

  it("reads the sandbox RuntimeClass for both processes and rejects a malformed name", () => {
    expect(loadConfig({ ...REQUIRED, KOBE_RUNTIME_CLASS: "gvisor" }).runtimeClassName).toBe(
      "gvisor",
    );
    expect(
      loadConfig({ ...REQUIRED, KOBE_PROCESS: "scheduler", KOBE_RUNTIME_CLASS: "kata-qemu" })
        .runtimeClassName,
    ).toBe("kata-qemu");
    expect(() => loadConfig({ ...REQUIRED, KOBE_RUNTIME_CLASS: "Not A Name" })).toThrow(
      /KOBE_RUNTIME_CLASS/,
    );
  });

  it("leaves the RuntimeClass unset when absent (the isolation gate then disables agents)", () => {
    expect(loadConfig(REQUIRED).runtimeClassName).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, KOBE_RUNTIME_CLASS: " " }).runtimeClassName).toBeUndefined();
  });

  describe("SMTP (KOBE-13)", () => {
    it("requires a host and a From address for the API server, with safe defaults", () => {
      expect(loadConfig(REQUIRED).smtp).toEqual({
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        from: { name: "Kobe", address: "kobe@example.com" },
      });
      const { KOBE_SMTP_HOST: _h, ...noHost } = REQUIRED;
      expect(() => loadConfig(noHost)).toThrow(/KOBE_SMTP_HOST/);
      const { KOBE_SMTP_FROM: _f, ...noFrom } = REQUIRED;
      expect(() => loadConfig(noFrom)).toThrow(/KOBE_SMTP_FROM/);
    });

    it("accepts a bare From address and rejects malformed ones (no header injection)", () => {
      expect(loadConfig({ ...REQUIRED, KOBE_SMTP_FROM: "noreply@example.com" }).smtp?.from).toEqual(
        { address: "noreply@example.com" },
      );
      for (const bad of [
        "not an address",
        "Kobe <a@b.c>\r\nBcc: x@y.z",
        "Kobe <>",
        "a@b.c, d@e.f",
      ]) {
        expect(() => loadConfig({ ...REQUIRED, KOBE_SMTP_FROM: bad }), bad).toThrow(
          /KOBE_SMTP_FROM/,
        );
      }
    });

    it("reads port, security and credentials", () => {
      const smtp = loadConfig({
        ...REQUIRED,
        KOBE_SMTP_PORT: "465",
        KOBE_SMTP_SECURITY: "tls",
        KOBE_SMTP_USERNAME: "mailer",
        KOBE_SMTP_PASSWORD: "s3cret",
      }).smtp;
      expect(smtp).toMatchObject({
        port: 465,
        security: "tls",
        auth: { user: "mailer", pass: "s3cret" },
      });
      expect(() => loadConfig({ ...REQUIRED, KOBE_SMTP_SECURITY: "ssl3" })).toThrow(
        /KOBE_SMTP_SECURITY/,
      );
      expect(() => loadConfig({ ...REQUIRED, KOBE_SMTP_PORT: "0" })).toThrow(/KOBE_SMTP_PORT/);
    });

    it("requires username and password together, and never sends them over plain SMTP", () => {
      expect(() => loadConfig({ ...REQUIRED, KOBE_SMTP_USERNAME: "mailer" })).toThrow(
        /KOBE_SMTP_PASSWORD/,
      );
      expect(() =>
        loadConfig({
          ...REQUIRED,
          KOBE_SMTP_SECURITY: "none",
          KOBE_SMTP_USERNAME: "mailer",
          KOBE_SMTP_PASSWORD: "hunter2",
        }),
      ).toThrow(/KOBE_SMTP_SECURITY/);
      expect(() =>
        loadConfig({
          ...REQUIRED,
          KOBE_SMTP_SECURITY: "none",
          KOBE_SMTP_USERNAME: "mailer",
          KOBE_SMTP_PASSWORD: "hunter2",
        }),
      ).not.toThrow(/hunter2/);
      expect(loadConfig({ ...REQUIRED, KOBE_SMTP_SECURITY: "none" }).smtp?.security).toBe("none");
    });

    it("is not needed by the scheduler", () => {
      expect(
        loadConfig({ KOBE_PROCESS: "scheduler", KOBE_DATABASE_URL: REQUIRED.KOBE_DATABASE_URL })
          .smtp,
      ).toBeUndefined();
    });
  });
});
