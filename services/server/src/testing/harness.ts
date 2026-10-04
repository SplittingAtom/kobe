import pg from "pg";
import { expect } from "vitest";
import { createTestDatabase, testServerUrl } from "@kobe/db/testing";
import { createApp } from "../app.js";
import { BackgroundTasks } from "../background.js";
import { createServerDeps, type ServerDeps, type ServerDepsOptions } from "../deps.js";
import { waitForAppSessionsToClose } from "./app-sessions.js";
import { TestBrowser } from "./browser.js";
import { MemoryMailer } from "./mailer.js";

export const PUBLIC_URL = "http://kobe.test";
export const PASSWORD = "a long enough password";

/** A server on its own throwaway database, with an in-memory mailer and a superuser client. */
export interface Harness {
  readonly deps: ServerDeps;
  readonly app: ReturnType<typeof createApp>;
  readonly mailer: MemoryMailer;
  /** Superuser connection for assertions and test-only setup (bypasses RLS). */
  readonly admin: pg.Client;
  /** App-role URL of the test database (LISTEN connections). */
  readonly appUrl: string;
  browser(): TestBrowser;
  /** Creates a user with PASSWORD (and an optional install role) and returns its id. */
  createUser(email: string, installRole?: "owner" | "admin"): Promise<string>;
  /** Signs in with email + PASSWORD (no 2FA) and returns the browser. */
  signIn(email: string, password?: string): Promise<TestBrowser>;
  close(): Promise<void>;
}

export async function openHarness(
  options: Pick<ServerDepsOptions, "agents" | "models"> = {},
): Promise<Harness> {
  const database = await createTestDatabase(testServerUrl());
  // A single client: unlike Pool#end, Client#end resolves only once the connection is closed.
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  const background = new BackgroundTasks();
  const mailer = new MemoryMailer(background);
  const deps = createServerDeps({
    background,
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "h".repeat(48),
    setupToken: "setup-token-for-harness-tests-01",
    trustedProxies: ["127.0.0.1/32"],
    mailer,
    ...options,
  });
  const app = createApp(deps);
  const browser = () => new TestBrowser(app, PUBLIC_URL);
  return {
    deps,
    app,
    mailer,
    admin,
    appUrl: database.appUrl,
    browser,
    async createUser(email, installRole) {
      const user = await deps.createUserWithPassword(
        { email, name: email.split("@")[0] ?? email, password: PASSWORD },
        installRole ? { installRole } : {},
      );
      return user.id;
    },
    async signIn(email, password = PASSWORD) {
      const b = browser();
      const res = await b.post("/api/auth/sign-in/email", { email, password });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return b;
    },
    async close() {
      await deps.close();
      await admin.end();
      await waitForAppSessionsToClose(database.appRole);
      await database.drop();
    },
  };
}
