import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Better Auth tables (install-wide, spec D7). Field names follow Better Auth's model fields; the
// client's snake_case casing maps them to columns. Ids are UUIDs (advanced.database.generateId).
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const userRef = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: userRef(),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: userRef(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const twoFactors = pgTable(
  "two_factors",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: userRef(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().default(false),
    failedVerificationCount: integer().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [index("two_factors_user_id_idx").on(t.userId)],
);

export const passkeys = pgTable(
  "passkeys",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: userRef(),
    name: text(),
    publicKey: text().notNull(),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    aaguid: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [index("passkeys_user_id_idx").on(t.userId)],
);

/** JWT signing keys (Better Auth jwt plugin; private keys are stored encrypted). */
export const jwks = pgTable("jwks", {
  id: uuid().primaryKey().defaultRandom(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  alg: text(),
  crv: text(),
  createdAt: createdAt(),
  expiresAt: timestamp({ withTimezone: true }),
});

export const installRole = pgEnum("install_role", ["owner", "admin"]);

/** Install roles (spec D8): one Owner (enforced), any number of Admins; absent row = User. */
export const installRoles = pgTable(
  "install_roles",
  {
    userId: userRef(),
    role: installRole().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId] }),
    uniqueIndex("install_roles_single_owner")
      .on(t.role)
      .where(sql`${t.role} = 'owner'`),
  ],
);

/** Install-wide settings (e.g. require_2fa), one row per key. */
export const installSettings = pgTable("install_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: updatedAt(),
});
