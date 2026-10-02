import { createDb, type KobeDatabase } from "@kobe/db";
import { createAuth, type KobeAuth } from "./auth/auth.js";

export interface ServerDepsOptions {
  readonly databaseUrl: string;
  readonly publicUrl: string;
  readonly authSecret: string;
}

export interface ServerDeps {
  readonly database: KobeDatabase;
  readonly auth: KobeAuth;
  /** Creates an email+password user without sign-up (first-run Owner, invites in KOBE-13). */
  createUserWithPassword(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<{ id: string }>;
  /** Deletes every session of a user; the next request with any of their cookies is rejected. */
  revokeAllSessions(userId: string): Promise<void>;
  close(): Promise<void>;
}

export function createServerDeps(options: ServerDepsOptions): ServerDeps {
  const database = createDb(options.databaseUrl);
  const auth = createAuth({
    db: database.db,
    publicUrl: options.publicUrl,
    secret: options.authSecret,
  });

  return {
    database,
    auth,
    async createUserWithPassword({ email, name, password }) {
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.createUser(
        { email: email.toLowerCase(), name, emailVerified: true },
        { method: "email-password" },
      );
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await ctx.password.hash(password),
      });
      return { id: user.id };
    },
    async revokeAllSessions(userId) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(userId);
    },
    close: () => database.close(),
  };
}
