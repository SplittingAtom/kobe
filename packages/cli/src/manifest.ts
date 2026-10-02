import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { deriveKeys, signManifest, verifyManifestSignature, type BackupKeys } from "./crypto.js";

export const MANIFEST_FORMAT = "kobe-backup/1";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SIGNATURE_FILE = "manifest.json.sig";
/** pg_dump custom format, AES-256-GCM encrypted. */
export const DATABASE_FILE = "database.dump.enc";
/** Object listing (JSON lines), AES-256-GCM encrypted. */
export const OBJECTS_FILE = "objects.jsonl.enc";
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

/** Same rule as @kobe/db's quoteIdent: plain lowercase identifiers only. */
const tableName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "invalid table name");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "invalid sha256");
const hex = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), "invalid hex");
const count = z.number().int().nonnegative();

const fileRef = z.object({
  // Only the fixed file names: a manifest must never point outside its own directory.
  path: z.enum([DATABASE_FILE, OBJECTS_FILE]),
  /** Checksum and size of the ciphertext on disk. */
  sha256,
  bytes: count,
  iv: hex(12),
  tag: hex(16),
});

const manifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    createdAt: z.iso.datetime(),
    postgres: z.object({ serverVersion: z.string().max(200), pgDumpVersion: z.string().max(200) }),
    /** drizzle.__drizzle_migrations at the time of the snapshot, oldest first. */
    migrations: z.array(z.object({ hash: sha256, createdAt: count })).min(1),
    /** Tables whose rows are in the dump, with their row counts in the dump's snapshot. */
    tables: z.array(z.object({ name: tableName, rows: count })),
    /** Tables present at backup time whose rows were deliberately left out. */
    excludedTables: z.array(z.object({ name: tableName, reason: z.string().max(500) })),
    files: z.object({ database: fileRef, objects: fileRef.nullable() }),
    encryption: z.object({
      cipher: z.literal("aes-256-gcm"),
      kdf: z.literal("hkdf-sha256"),
      salt: hex(16),
    }),
    /** What the backup checked it covers: only `public` holds data, no large objects. */
    coverage: z.object({
      schemas: z.tuple([z.literal("public")]),
      otherSchemasChecked: z.literal(true),
      largeObjects: z.literal(0),
    }),
    objectStorage: z
      .object({
        endpoint: z.string().max(500),
        bucket: z.string().min(1).max(255),
        prefix: z.string().max(1024),
        objects: count,
        bytes: count,
        /** Distinct object keys referenced from blob-ref columns, all present in the listing. */
        referencedObjects: count,
        blobRefColumns: z.array(z.object({ table: tableName, column: tableName })),
      })
      .nullable(),
  })
  .superRefine((m, ctx) => {
    const names = [...m.tables, ...m.excludedTables].map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({ code: "custom", message: `table listed more than once: ${dupes.join(", ")}` });
    }
    if ((m.objectStorage === null) !== (m.files.objects === null)) {
      ctx.addIssue({ code: "custom", message: "objectStorage and files.objects must agree" });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type FileRef = z.infer<typeof fileRef>;

/** Parses and validates a manifest; a backup directory is untrusted input. */
export function parseManifest(text: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Invalid backup manifest: not JSON");
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid backup manifest: ${issues.join("; ")}`);
  }
  return parsed.data;
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Reads manifest.json and verifies its HMAC with the operator's key before parsing it; nothing in
 * an unsigned or re-signed-with-another-key backup is trusted.
 */
export async function readSignedManifest(
  dir: string,
  master: Buffer,
): Promise<{ manifest: Manifest; keys: BackupKeys; fingerprint: string }> {
  const path = join(dir, MANIFEST_FILE);
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) {
    throw new Error(`${MANIFEST_FILE} is too large to be a Kobe manifest`);
  }
  const body = await readFile(path);
  let signature: string;
  try {
    signature = (await readFile(join(dir, MANIFEST_SIGNATURE_FILE), "utf8")).trim();
  } catch {
    throw new Error(`${MANIFEST_SIGNATURE_FILE} is missing: refusing an unsigned backup`);
  }
  let salt: string | undefined;
  try {
    salt = (JSON.parse(body.toString("utf8")) as { encryption?: { salt?: unknown } }).encryption
      ?.salt as string | undefined;
  } catch {
    // Reported as a signature failure below.
  }
  if (typeof salt !== "string" || !/^[0-9a-f]{32}$/.test(salt)) {
    throw new Error("The backup manifest is not signed by this backup key (or was modified)");
  }
  const keys = deriveKeys(master, Buffer.from(salt, "hex"));
  if (!verifyManifestSignature(keys.mac, body, signature)) {
    throw new Error(
      "The backup manifest signature does not verify: wrong backup key, or the backup was modified",
    );
  }
  return {
    manifest: parseManifest(body.toString("utf8")),
    keys,
    fingerprint: manifestFingerprint(body),
  };
}

/** Short, human-comparable identity of a backup: sha256 of manifest.json's exact bytes. */
export function manifestFingerprint(body: Buffer): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export async function writeSignedManifest(
  dir: string,
  manifest: Manifest,
  keys: BackupKeys,
): Promise<string> {
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, MANIFEST_FILE), body, { mode: 0o600 });
  await writeFile(join(dir, MANIFEST_SIGNATURE_FILE), `${signManifest(keys.mac, body)}\n`, {
    mode: 0o600,
  });
  return manifestFingerprint(body);
}

/** Fails unless `dir/ref.path` has exactly the recorded size and checksum. */
export async function verifyFile(dir: string, ref: FileRef): Promise<void> {
  const actual = await sha256File(join(dir, ref.path));
  if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.bytes) {
    throw new Error(
      `${ref.path} does not match the manifest checksum: the backup is corrupt or was modified`,
    );
  }
}
